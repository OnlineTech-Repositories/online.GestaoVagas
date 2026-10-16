using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;

namespace VacancyControl.Infrastructure.Persistence;

/// <summary>
/// Dados FICTÍCIOS para avaliação local (Seed:DemoData = true). Cria um usuário por perfil e cenários que cobrem
/// os principais estados: vencidas, em risco, reposição aguardando o cliente, pausa, fim de vigência, valor pendente e R&amp;S.
/// As datas são relativas a "hoje", para que as situações de SLA façam sentido em qualquer dia.
/// A senha dos usuários de demonstração vem de configuração segura (Seed:DemoPassword).
/// </summary>
internal static class DemoDataSeeder
{
    public static async Task SeedAsync(IServiceProvider sp, IConfiguration config, ILogger logger, CancellationToken ct)
    {
        var db = sp.GetRequiredService<AppDbContext>();
        if (await db.Orders.AnyAsync(ct)) return;

        var password = config["Seed:DemoPassword"];
        if (string.IsNullOrWhiteSpace(password))
        {
            logger.LogWarning("Seed:DemoData ativo, mas Seed:DemoPassword não foi definido. Dados de demonstração não criados.");
            return;
        }

        sp.GetRequiredService<IAuditContext>().Set("DEMO_SEED");
        var today = sp.GetRequiredService<IClock>().Today;
        DateOnly D(int daysFromToday) => today.AddDays(daysFromToday);

        // ------------------------------------------------------------ usuários (um por perfil)
        var userManager = sp.GetRequiredService<UserManager<AppUser>>();
        var users = new Dictionary<string, AppUser>();
        async Task<AppUser> CreateUserAsync(string role, string name, string email)
        {
            var user = new AppUser
            {
                Name = name, Email = email, UserName = email, EmailConfirmed = true,
                MustChangePassword = false, CreatedAt = DateTimeOffset.UtcNow,
            };
            var result = await userManager.CreateAsync(user, password);
            if (!result.Succeeded)
                throw new InvalidOperationException("Falha ao criar usuário de demonstração: " +
                                                    string.Join(" ", result.Errors.Select(e => e.Description)));
            await userManager.AddToRoleAsync(user, role);
            return user;
        }

        foreach (var (role, name, email) in new[]
                 {
                     (Roles.Commercial, "Carla Comercial (demo)", "comercial@demo.local"),
                     (Roles.Nacc, "Nina NACC (demo)", "nacc@demo.local"),
                     (Roles.Dp, "Davi DP (demo)", "dp@demo.local"),
                     (Roles.Rh, "Rita RH (demo)", "rh@demo.local"),
                     (Roles.RhManager, "Helena Gestora de RH (demo)", "gestor.rh@demo.local"),
                     (Roles.Manager, "Gustavo Gestor (demo)", "gestor@demo.local"),
                     (Roles.Controllership, "Clara Controladoria (demo)", "controladoria@demo.local"),
                     (Roles.Admin, "Alice Administradora (demo)", "admin@demo.local"),
                 })
            users[role] = await CreateUserAsync(role, name, email);
        // Segundo analista de RH, para a distribuição dos pedidos entre a equipe.
        var rh2 = await CreateUserAsync(Roles.Rh, "Renato RH (demo)", "rh2@demo.local");

        // Um usuário com todos os perfis, para o teste completo da aplicação num login só.
        var everyone = new AppUser
        {
            Name = "Todos os Perfis (demo)", Email = "todos@demo.local", UserName = "todos@demo.local", EmailConfirmed = true,
            MustChangePassword = false, CreatedAt = DateTimeOffset.UtcNow,
        };
        if ((await userManager.CreateAsync(everyone, password)).Succeeded)
            await userManager.AddToRolesAsync(everyone, Roles.All);

        // ------------------------------------------------------------ cadastros
        var group1 = new GroupEntity { Name = "ON LINE Serviços (demo)", Cnpj = FakeCnpj("11222333000") };
        var group2 = new GroupEntity { Name = "ON LINE Facilities (demo)", Cnpj = FakeCnpj("11222333000", branch: 2) };
        var clientA = new Client { LegalName = "Logística Exemplo Ltda (demo)", Cnpj = FakeCnpj("12345678000"), HasMultipleUnits = true };
        var clientB = new Client { LegalName = "Varejo Modelo S.A. (demo)", Cnpj = FakeCnpj("98765432000"), HasMultipleUnits = true };
        var stockist = new JobRole { Name = "Estoquista" };
        var forklift = new JobRole { Name = "Operador de empilhadeira" };
        var cleaner = new JobRole { Name = "Auxiliar de limpeza" };
        var hrAnalyst = new JobRole { Name = "Analista de RH" };
        var cdCajamar = new WorkLocation { Code = "CD-01", Name = "CD Cajamar", ClientId = clientA.Id };
        var storeCenter = new WorkLocation { Code = "LJ-001", Name = "Loja Centro", ClientId = clientB.Id };
        var storeNorth = new WorkLocation { Code = "LJ-002", Name = "Loja Shopping Norte", ClientId = clientB.Id };
        var headOffice = new WorkLocation { Name = "Sede do cliente" };
        var pauseDocs = new PauseReason { Name = "Aguardando documentação do cliente" };
        db.AddRange(group1, group2, clientA, clientB, stockist, forklift, cleaner, hrAnalyst, cdCajamar, storeCenter, storeNorth, headOffice, pauseDocs,
            new PauseReason { Name = "Cliente suspendeu temporariamente a vaga" });

        var contractA = new Contract
        {
            Client = clientA, ClientId = clientA.Id, ContractingUnit = cdCajamar, ContractingUnitId = cdCajamar.Id,
            Name = ContractCode.Build(today.Year, ContractCode.Segment(cdCajamar.Code!), 1), GroupEntity = group1, GroupEntityId = group1.Id,
            Modalities = [Modality.MOT, Modality.MOE], StartDate = D(-200), CommercialOwnerId = users[Roles.Commercial].Id,
            SlaNewDays = 10, SlaReplacementDays = 5,
        };
        var contractB = new Contract
        {
            Client = clientB, ClientId = clientB.Id, ContractingUnit = storeCenter, ContractingUnitId = storeCenter.Id,
            Name = ContractCode.Build(today.Year, ContractCode.Segment(storeCenter.Code!), 1), GroupEntity = group2, GroupEntityId = group2.Id,
            Modalities = [Modality.FAC, Modality.RS], StartDate = D(-120), CommercialOwnerId = users[Roles.Commercial].Id,
        };
        db.AddRange(contractA, contractB);
        db.Add(new SlaTarget { Modality = Modality.FAC, DemandType = DemandType.NEW, Days = 15, ValidFrom = D(-300) });

        var controller = users[Roles.Controllership].Id;
        var commercial = users[Roles.Commercial].Id;
        ContractRate Rate(Contract c, JobRole j, decimal? monthly, RateStatus status, decimal? fee = null) => new()
        {
            Contract = c, ContractId = c.Id, JobRole = j, JobRoleId = j.Id, MonthlyValue = monthly, FeeValue = fee,
            ValidFrom = D(-365), Status = status, CreatedBy = commercial,
            ValidatedBy = status == RateStatus.VALIDATED ? controller : null,
            ValidatedAt = status == RateStatus.VALIDATED ? DateTimeOffset.UtcNow : null,
        };
        var rateStockist = Rate(contractA, stockist, 3000m, RateStatus.VALIDATED);
        var rateForklift = Rate(contractA, forklift, 4500m, RateStatus.VALIDATED);
        var rateCleaner = Rate(contractB, cleaner, 2700m, RateStatus.VALIDATED);
        var rateHr = Rate(contractB, hrAnalyst, null, RateStatus.VALIDATED, fee: 5000m);
        // Reajuste ainda pendente: fica na fila da Controladoria e não entra nos pedidos até ser validado.
        var rateForkliftAdjustment = Rate(contractA, forklift, 4800m, RateStatus.PENDING);
        rateForkliftAdjustment.ValidFrom = D(-10);
        db.AddRange(rateStockist, rateForklift, rateForkliftAdjustment, rateCleaner, rateHr);

        Order NewOrder(Contract c, Modality m, JobRole j, WorkLocation l, int qty, int request, int registered, int desired,
            TermType term, int? termEnd = null, int? duration = null, string? notes = null) => new()
        {
            Contract = c, ContractId = c.Id, Modality = m, JobRole = j, JobRoleId = j.Id, WorkLocation = l, WorkLocationId = l.Id,
            Quantity = qty, ClientRequestDate = D(request), RegisteredAt = D(registered), DesiredStartDate = D(desired),
            TermType = term, TermEndDate = termEnd is { } e ? D(e) : null, TermDurationDays = duration, Notes = notes,
            CreatedBy = commercial,
            // Pedidos de demonstração já aprovados pelo cliente na data do registro.
            ApprovalStatus = OrderApprovalStatus.APPROVED, ClientDecisionDate = D(registered),
            ApprovalRecordedAt = DateTimeOffset.UtcNow, ApprovalRecordedBy = commercial,
        };

        List<Position> Positions(Order o, ContractRate rate, int? sla, SlaTargetSource source)
        {
            for (var i = 1; i <= o.Quantity; i++)
                o.Positions.Add(Position.CreateNew(o, i, o.DesiredStartDate, o.RegisteredAt, rate, sla, source));
            return o.Positions;
        }

        // Uma publicação no JobConvo por pedido: as posições abertas entram em recrutamento juntas.
        var rh = users[Roles.Rh].Id;
        var nacc = users[Roles.Nacc].Id;
        void Publish(Order o, string code, int publishedAt, string? notes = null) =>
            o.RecordJobconvo(true, code, D(publishedAt), notes, rh, DateTimeOffset.UtcNow);

        // Candidatos fictícios: CPFs com dígitos verificadores válidos, gerados a partir de um número.
        var sexes = new[] { CandidateSex.FEMALE, CandidateSex.MALE, CandidateSex.NOT_INFORMED };
        CandidateData Candidate(string name, int n) =>
            new(name, today.AddYears(-20 - n % 15).AddDays(-37 * n), sexes[n % 3], FakeCpf(n));

        var employee = 0;
        void Fill(Position p, int approved, int admission, int firstDay)
        {
            employee++;
            p.ApproveCandidate(D(approved), Candidate($"Colaborador Demo {employee:00}", employee), today).CreatedBy = rh;
            p.RegisterAdmission(D(admission), $"DEMO{employee:000}");
            p.ConfirmFirstDay(D(firstDay), "Comparecimento confirmado pelo cliente por e-mail (demo).", nacc, DateTimeOffset.UtcNow);
        }

        // ------------------------------------------------------------ pedido 1: 10 estoquistas (exemplo-base da SPEC)
        var order1 = NewOrder(contractA, Modality.MOT, stockist, cdCajamar, 10, -24, -22, -13, TermType.INDEFINITE,
            notes: "Pedido recebido por WhatsApp.");
        order1.JobDescription = "Atividades: recebimento, conferência e armazenagem de mercadorias; separação de pedidos.\n\n"
            + "Requisitos: ensino fundamental completo; experiência de 6 meses em estoque.\n"
            + "Desejável: curso de empilhadeira.\n\nTurno: segunda a sábado, 6h às 14h20.";
        var p1 = Positions(order1, rateStockist, 10, SlaTargetSource.CONTRACT);
        Publish(order1, "JC-DEMO-1001", -21, "Uma publicação para as 10 vagas de estoquista.");
        Fill(p1[0], -15, -13, -13);
        Fill(p1[1], -15, -12, -12);
        Fill(p1[2], -14, -11, -11);
        Fill(p1[3], -14, -10, -8);
        p1[4].ApproveCandidate(D(-6), Candidate("Ana Paula Souza", 21), today).CreatedBy = rh; p1[4].RegisterAdmission(D(-1), "DEMO101");
        p1[5].ApproveCandidate(D(-6), Candidate("Bruno Henrique Lima", 22), today).CreatedBy = rh; p1[5].RegisterAdmission(D(-1));
        p1[6].ApproveCandidate(D(-2), Candidate("Carla Mendes", 23), today).CreatedBy = rh;
        p1[8].StartPause(pauseDocs.Id, D(-5)).Reason = pauseDocs;
        // p1[7] e p1[9] em recrutamento.

        // Reposição confirmada pelo cliente (em risco: meta contratual de 5 dias).
        var t1 = Termination.Register(p1[0], false, D(-6), TerminationSource.DP, TerminationType.RESIGNATION,
            "Pediu demissão na primeira semana.", D(-5));
        var r1 = Position.CreateReplacement(p1[0], t1, 11);
        order1.Positions.Add(r1);
        r1.ConfirmReplacement(D(-4), contractA.SlaReplacementDays, SlaTargetSource.CONTRACT); // herda a publicação

        // Reposição aguardando a decisão do cliente.
        var t2 = Termination.Register(p1[1], false, D(-2), TerminationSource.NACC, TerminationType.ABANDONMENT, null, D(-1));
        order1.Positions.Add(Position.CreateReplacement(p1[1], t2, 12));

        // ------------------------------------------------------------ pedido 2: vigência fixa já vencida (o job encerra)
        var order2 = NewOrder(contractA, Modality.MOT, forklift, cdCajamar, 2, -35, -34, -30, TermType.FIXED_END, termEnd: -4);
        var p2 = Positions(order2, rateForklift, 10, SlaTargetSource.CONTRACT);
        Publish(order2, "JC-DEMO-1002", -33);
        Fill(p2[1], -25, -21, -19);

        // ------------------------------------------------------------ pedido 3: facilities, duração preservada, meta padrão
        var order3 = NewOrder(contractB, Modality.FAC, cleaner, storeCenter, 3, -9, -8, -1, TermType.PRESERVED_DURATION, duration: 90);
        var p3 = Positions(order3, rateCleaner, 15, SlaTargetSource.DEFAULT);
        // Recrutamento sem JobConvo: a loja indicou candidatos.
        order3.RecordJobconvo(false, null, null, "Vagas preenchidas por indicação da loja; sem publicação no JobConvo.", rh,
            DateTimeOffset.UtcNow);
        p3[2].Cancel(D(-4), "Cliente reduziu o quadro da loja.");

        // ------------------------------------------------------------ pedido 4: R&S (sem cálculo em R$, sem meta)
        var order4 = NewOrder(contractB, Modality.RS, hrAnalyst, storeCenter, 1, -13, -13, 6, TermType.INDEFINITE);
        var p4 = Positions(order4, rateHr, null, SlaTargetSource.NONE);
        // p4[0] aberta: o RH ainda não informou a publicação no JobConvo.

        // ------------------------------------------------------------ pedido 5: aguardando a aprovação do cliente
        var order5 = NewOrder(contractB, Modality.FAC, cleaner, storeCenter, 4, -2, -2, 5, TermType.INDEFINITE,
            notes: "Pedido feito por telefone; o cliente vai formalizar por e-mail.");
        order5.ApprovalStatus = OrderApprovalStatus.AWAITING_CLIENT_APPROVAL;
        order5.ClientDecisionDate = null;
        order5.ApprovalRecordedAt = null;
        order5.ApprovalRecordedBy = null;
        for (var i = 1; i <= order5.Quantity; i++)
            order5.Positions.Add(Position.CreateNew(order5, i, order5.DesiredStartDate, null, rateCleaner, null, SlaTargetSource.NONE));
        // Publicação ainda não informada: o RH pode registrá-la antes da aprovação do cliente.

        // ------------------------------------------------------------ analistas de RH responsáveis
        var rita = (users[Roles.Rh].Id, users[Roles.Rh].Name);
        var renato = (rh2.Id, rh2.Name);
        var rhManager = users[Roles.RhManager].Id;
        order1.SetRhAnalysts([rita, renato], rhManager, DateTimeOffset.UtcNow);
        order2.SetRhAnalysts([rita], rhManager, DateTimeOffset.UtcNow);
        order3.SetRhAnalysts([renato], rhManager, DateTimeOffset.UtcNow);
        // Pedidos 4 e 5: aguardando atribuição do RH.

        db.Orders.AddRange(order1, order2, order3, order4, order5);
        await db.SaveChangesAsync(ct);
        logger.LogInformation("Dados de demonstração criados: 5 pedidos, {Count} posições e 10 usuários (um por perfil, um segundo analista de RH e um com todos).",
            order1.Positions.Count + order2.Positions.Count + order3.Positions.Count + order4.Positions.Count + order5.Positions.Count);
    }

    /// <summary>CPF fictício com dígitos verificadores válidos (base de 9 dígitos a partir de <paramref name="n"/>).</summary>
    private static string FakeCpf(int n)
    {
        var baseDigits = (100000000 + n * 7919).ToString()[..9];
        int Digit(string digits)
        {
            var rest = digits.Select((c, i) => (c - '0') * (digits.Length + 1 - i)).Sum() % 11;
            return rest < 2 ? 0 : 11 - rest;
        }
        var d1 = Digit(baseDigits);
        var d2 = Digit(baseDigits + d1);
        return $"{baseDigits}{d1}{d2}";
    }

    /// <summary>CNPJ fictício com dígitos verificadores válidos (base de 11 dígitos + filial).</summary>
    private static string FakeCnpj(string root8Plus000, int branch = 1)
    {
        var baseDigits = root8Plus000[..8] + branch.ToString("0000");
        int Digit(string digits, int[] weights)
        {
            var rest = digits.Select((c, i) => (c - '0') * weights[i]).Sum() % 11;
            return rest < 2 ? 0 : 11 - rest;
        }
        var d1 = Digit(baseDigits, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
        var d2 = Digit(baseDigits + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
        return $"{baseDigits}{d1}{d2}";
    }
}
