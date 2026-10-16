/** Cliente HTTP dos testes: guarda os cookies (sessão e CSRF) e devolve o token CSRF nas escritas, como o front-end. */
export class Client {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.jar = new Map();
  }

  async request(method, path, body, { form = null, headers = {} } = {}) {
    const h = { Accept: 'application/json', ...headers };
    if (this.jar.size) h.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET' && this.jar.has('XSRF-TOKEN')) h['X-XSRF-TOKEN'] ??= this.jar.get('XSRF-TOKEN');
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.baseUrl + path, { method, headers: h, body: payload, redirect: 'manual' });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (!value || /expires=Thu, 01 Jan 1970/i.test(cookie)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = res.status === 204 ? '' : await res.text();
    let data = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // corpo não JSON (arquivo, HTML)
    }
    return { status: res.status, data, headers: res.headers };
  }

  get = (path) => this.request('GET', path);
  post = (path, body = {}) => this.request('POST', path, body);
  put = (path, body = {}) => this.request('PUT', path, body);

  async login(email, password) {
    await this.get('/api/saude');
    return this.post('/api/auth/login', { email, password });
  }
}
