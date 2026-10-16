/**
 * DOM mínimo para executar as telas fora do navegador.
 *
 * Existe por um motivo concreto: um `indicador is not defined` derrubou a tela
 * de detalhe do pagamento e passou por 173 testes, porque nenhum deles chegava
 * a executar o código de renderização. Com este apoio, cada tela é montada de
 * verdade durante `node --test` e um identificador faltando vira teste vermelho.
 *
 * Implementa só o que o front-end usa — não é um navegador.
 */

class No extends EventTarget {
  constructor() {
    super();
    this.pai = null;
    this.filhos = [];
  }

  remove() {
    this.pai?.removeChild(this);
  }
}

class NoTexto extends No {
  constructor(texto) {
    super();
    this.nodeType = 3;
    this.dado = String(texto);
  }

  get textContent() {
    return this.dado;
  }

  set textContent(v) {
    this.dado = String(v);
  }
}

/** `.classe`, `tag`, `#id`, `[attr]`, `[attr=valor]`, `:checked` e listas com vírgula. */
function compilarSeletor(seletor) {
  const partes = seletor.split(',').map((s) => s.trim()).filter(Boolean);

  const testes = partes.map((parte) => {
    const condicoes = [];
    const restante = parte.replace(
      /\[([\w-]+)(?:([~|^$*]?=)"?'?([^\]"']*)"?'?)?\]/g,
      (_, attr, op, valor) => {
        condicoes.push((el) => {
          const atual = el.getAttribute(attr);
          if (atual === null) return false;
          return op ? atual === valor : true;
        });
        return '';
      },
    );

    for (const m of restante.matchAll(/\.([\w-]+)/g)) {
      const classe = m[1];
      condicoes.push((el) => el.classList.contains(classe));
    }
    for (const m of restante.matchAll(/#([\w-]+)/g)) {
      const id = m[1];
      condicoes.push((el) => el.id === id);
    }
    if (/:checked\b/.test(restante)) condicoes.push((el) => el.checked === true);
    if (/:disabled\b/.test(restante)) condicoes.push((el) => el.disabled === true);

    const tag = restante.match(/^([a-zA-Z][\w-]*)/)?.[1];
    if (tag) condicoes.push((el) => el.tag === tag.toLowerCase());

    return (el) => condicoes.every((c) => c(el));
  });

  return (el) => testes.some((t) => t(el));
}

const PARA_DATASET = (nome) => nome.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

class Elemento extends No {
  constructor(tag) {
    super();
    this.nodeType = 1;
    this.tag = String(tag).toLowerCase();
    this.atributos = new Map();
    this.style = {};
    this.dataset = {};
    this._valor = null;
    this.__elemento = true;

    const dono = this;
    this.classList = {
      add: (...cs) => dono.#classes((atual) => [...atual, ...cs]),
      remove: (...cs) => dono.#classes((atual) => atual.filter((c) => !cs.includes(c))),
      toggle: (c) => dono.#classes((atual) => (atual.includes(c) ? atual.filter((x) => x !== c) : [...atual, c])),
      contains: (c) => dono.className.split(/\s+/).includes(c),
    };
  }

  #classes(transformar) {
    const atual = this.className.split(/\s+/).filter(Boolean);
    this.className = [...new Set(transformar(atual))].join(' ');
  }

  get className() {
    return this.atributos.get('class') ?? '';
  }

  set className(v) {
    this.atributos.set('class', String(v));
  }

  get id() {
    return this.atributos.get('id') ?? '';
  }

  set id(v) {
    this.atributos.set('id', String(v));
  }

  get name() {
    return this.atributos.get('name') ?? '';
  }

  get type() {
    return this.atributos.get('type') ?? (this.tag === 'input' ? 'text' : '');
  }

  get value() {
    return this._valor ?? this.atributos.get('value') ?? '';
  }

  set value(v) {
    this._valor = v === null || v === undefined ? '' : String(v);
  }

  get checked() {
    return this._checked ?? this.atributos.has('checked');
  }

  set checked(v) {
    this._checked = Boolean(v);
  }

  get disabled() {
    return this._disabled ?? this.atributos.has('disabled');
  }

  set disabled(v) {
    this._disabled = Boolean(v);
  }

  setAttribute(nome, valor) {
    this.atributos.set(nome, String(valor));
    if (nome.startsWith('data-')) this.dataset[PARA_DATASET(nome.slice(5))] = String(valor);
  }

  getAttribute(nome) {
    if (this.atributos.has(nome)) return this.atributos.get(nome);
    if (nome.startsWith('data-')) {
      const chave = PARA_DATASET(nome.slice(5));
      if (chave in this.dataset) return String(this.dataset[chave]);
    }
    return null;
  }

  removeAttribute(nome) {
    this.atributos.delete(nome);
  }

  hasAttribute(nome) {
    return this.getAttribute(nome) !== null;
  }

  // ---- árvore ----

  #inserir(filhos, inicio) {
    const nos = filhos.flat(Infinity).filter((f) => f !== null && f !== undefined && f !== false);
    for (const f of nos) {
      const no = f instanceof No ? f : new NoTexto(String(f));
      no.pai?.removeChild(no);
      no.pai = this;
      if (inicio) this.filhos.unshift(no);
      else this.filhos.push(no);
    }
  }

  append(...filhos) {
    this.#inserir(filhos, false);
  }

  appendChild(filho) {
    this.#inserir([filho], false);
    return filho;
  }

  prepend(...filhos) {
    this.#inserir(filhos, true);
  }

  replaceChildren(...filhos) {
    for (const f of this.filhos) f.pai = null;
    this.filhos = [];
    this.#inserir(filhos, false);
  }

  removeChild(filho) {
    const i = this.filhos.indexOf(filho);
    if (i >= 0) {
      this.filhos.splice(i, 1);
      filho.pai = null;
    }
    return filho;
  }

  get firstChild() {
    return this.filhos[0] ?? null;
  }

  get childNodes() {
    return this.filhos;
  }

  get children() {
    return this.filhos.filter((f) => f.nodeType === 1);
  }

  get parentElement() {
    return this.pai;
  }

  get textContent() {
    return this.filhos.map((f) => f.textContent).join('');
  }

  set textContent(v) {
    this.replaceChildren(new NoTexto(String(v)));
  }

  *descendentes() {
    for (const f of this.filhos) {
      if (f.nodeType !== 1) continue;
      yield f;
      yield* f.descendentes();
    }
  }

  querySelectorAll(seletor) {
    const casa = compilarSeletor(seletor);
    return [...this.descendentes()].filter(casa);
  }

  querySelector(seletor) {
    const casa = compilarSeletor(seletor);
    for (const d of this.descendentes()) if (casa(d)) return d;
    return null;
  }

  closest(seletor) {
    const casa = compilarSeletor(seletor);
    let atual = this;
    while (atual) {
      if (atual.nodeType === 1 && casa(atual)) return atual;
      atual = atual.pai;
    }
    return null;
  }

  matches(seletor) {
    return compilarSeletor(seletor)(this);
  }

  // ---- interação ----

  /** `target`/`currentTarget` são preenchidos pelo próprio EventTarget. */
  disparar(tipo) {
    return this.dispatchEvent(new Event(tipo, { bubbles: true }));
  }

  click() {
    return this.disparar('click');
  }

  focus() {}
  blur() {}
  scrollIntoView() {}
  setSelectionRange() {}
  getBoundingClientRect() {
    return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 };
  }
}

/** Instala os globais de navegador. Devolve utilidades para os testes. */
export function instalarDom() {
  const documento = new Elemento('#document');
  const body = new Elemento('body');
  documento.append(body);

  for (const id of ['app', 'notificacoes-toast', 'modal-area']) {
    const div = new Elemento('div');
    div.id = id;
    body.append(div);
  }

  documento.createElement = (tag) => new Elemento(tag);
  documento.createTextNode = (t) => new NoTexto(t);
  documento.body = body;
  documento.documentElement = documento;
  documento.getElementById = (id) => [...documento.descendentes()].find((e) => e.id === id) ?? null;
  documento.cookie = 'csrf=teste';

  const janela = new EventTarget();
  janela.location = { hash: '', href: 'http://localhost/', assign() {}, reload() {} };
  janela.print = () => {};
  janela.confirm = () => true;
  janela.scrollTo = () => {};
  janela.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

  const FormDataReal = globalThis.FormData;
  class FormDataFalso extends FormDataReal {
    constructor(formulario) {
      super();
      if (!formulario?.__elemento) return;
      for (const c of formulario.querySelectorAll('input, select, textarea')) {
        if (!c.name || c.type === 'checkbox' || c.type === 'file') continue;
        this.append(c.name, c.value);
      }
    }
  }

  const anteriores = {
    document: globalThis.document,
    window: globalThis.window,
    Node: globalThis.Node,
    navigator: globalThis.navigator,
    CSS: globalThis.CSS,
    FormData: globalThis.FormData,
    setInterval: globalThis.setInterval,
    setTimeout: globalThis.setTimeout,
  };

  // O front-end mantém um setInterval de 60s para os contadores e toasts com
  // setTimeout. No navegador isso é inofensivo; no Node seguraria o processo
  // aberto depois dos testes. `unref` deixa os temporizadores rodarem sem
  // impedir o encerramento.
  const semSegurarProcesso = (original) => (...args) => {
    const t = original(...args);
    t?.unref?.();
    return t;
  };
  globalThis.setInterval = semSegurarProcesso(anteriores.setInterval);
  globalThis.setTimeout = semSegurarProcesso(anteriores.setTimeout);

  Object.defineProperty(globalThis, 'document', { value: documento, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: janela, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'Node', { value: No, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'CSS', {
    value: { escape: (s) => String(s).replace(/["\\]/g, '\\$&') },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'FormData', { value: FormDataFalso, configurable: true, writable: true });

  return {
    documento,
    janela,
    /** Texto visível da tela, para conferir conteúdo renderizado. */
    texto: (no = documento) => no.textContent,
    novoElemento: (tag = 'div') => new Elemento(tag),
    restaurar() {
      for (const [chave, valor] of Object.entries(anteriores)) {
        if (valor === undefined) delete globalThis[chave];
        else Object.defineProperty(globalThis, chave, { value: valor, configurable: true, writable: true });
      }
    },
  };
}
