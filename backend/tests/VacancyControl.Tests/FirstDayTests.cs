using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;
using static VacancyControl.Tests.Builders;

namespace VacancyControl.Tests;

/// <summary>Confirmação do 1º dia: matrícula vinda da admissão, justificativa obrigatória e evidência validada.</summary>
public class FirstDayTests
{
    private static readonly DateTimeOffset Now = new(2026, 12, 5, 10, 0, 0, TimeSpan.FromHours(-3));

    private static Position InAdmission(string? registration = null)
    {
        var p = NewPosition(Order());
        Recruit(p);
        p.ApproveCandidate(D("2026-12-02"), Candidate(), D("2026-12-02"));
        p.RegisterAdmission(D("2026-12-03"), registration);
        return p;
    }

    [Fact]
    public void Admission_KeepsTheOptionalRegistration_AndNoShowClearsIt()
    {
        var p = InAdmission("  M-77 ");
        Assert.Equal("M-77", p.AdmissionRegistration);

        p.AdmissionNoShow(Now);

        Assert.Null(p.AdmissionRegistration);
        Assert.Null(InAdmission(" ").AdmissionRegistration);
    }

    [Fact]
    public void FirstDay_RequiresJustification_AndRecordsWhoAndWhen()
    {
        var p = InAdmission("M-1");
        var nacc = Guid.NewGuid();

        Assert.Equal("justification", Assert.Throws<BusinessRuleException>(() =>
            p.ConfirmFirstDay(D("2026-12-05"), " ", nacc, Now)).Field);
        p.ConfirmFirstDay(D("2026-12-05"), " Cliente confirmou por e-mail ", nacc, Now);

        Assert.Equal(PositionStatus.FILLED, p.Status);
        Assert.Equal(("Maria da Silva", "M-1"), (p.EmployeeName, p.EmployeeRegistration)); // vêm da origem
        Assert.Equal("Cliente confirmou por e-mail", p.FirstDayJustification);
        Assert.Equal((nacc, Now), (p.FirstDayConfirmedBy!.Value, p.FirstDayConfirmedAt!.Value));
    }

    [Fact]
    public void Evidence_IsLinkedToThePosition()
    {
        var p = InAdmission();
        var evidence = p.AttachEvidence(EvidenceKind.FIRST_DAY, "presenca.pdf", "application/pdf", 1234, "chave");

        Assert.Same(evidence, Assert.Single(p.Evidences));
        Assert.Equal(p.Id, evidence.PositionId);
    }

    private static readonly byte[] Pdf = "%PDF-1.7 conteúdo"u8.ToArray();
    private static readonly byte[] Png = [0x89, (byte)'P', (byte)'N', (byte)'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0];
    private static readonly byte[] Jpg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 0];

    [Fact]
    public void EvidenceFiles_DetectTheTypeByContent()
    {
        Assert.Equal(("presenca.pdf", "application/pdf"), EvidenceFiles.Validate(new("presenca.pdf", "image/png", Pdf)));
        Assert.Equal("image/png", EvidenceFiles.Validate(new("a.png", "", Png)).ContentType);
        Assert.Equal("image/jpeg", EvidenceFiles.Validate(new("a.jpg", "", Jpg)).ContentType);
        Assert.Equal("relatorio.pdf", EvidenceFiles.Validate(new(@"C:\\pasta\\relatorio.pdf", "", Pdf)).FileName);
    }

    [Fact]
    public void EvidenceFiles_RejectOtherTypes_EmptyAndOversized()
    {
        Assert.Throws<BusinessRuleException>(() => EvidenceFiles.Validate(new("planilha.pdf", "application/pdf", "PK\u0003\u0004"u8.ToArray())));
        Assert.Throws<BusinessRuleException>(() => EvidenceFiles.Validate(new("vazio.pdf", "application/pdf", [])));
        var big = new byte[EvidenceFiles.MaxBytes + 1];
        Pdf.CopyTo(big, 0);
        Assert.Throws<BusinessRuleException>(() => EvidenceFiles.Validate(new("grande.pdf", "application/pdf", big)));
    }

    [Fact]
    public void FirstDay_RequiresTheRegistrationFromAdmission_WhichRhOrDpCanSetBefore()
    {
        var p = InAdmission();

        Assert.Equal("employeeRegistration", Assert.Throws<BusinessRuleException>(() =>
            p.ConfirmFirstDay(D("2026-12-05"), "Ok", null, Now)).Field);
        Assert.Equal("registration", Assert.Throws<BusinessRuleException>(() => p.SetAdmissionRegistration(" ")).Field);
        Assert.Equal(PositionStatus.IN_ADMISSION, p.Status);
        Assert.True(p.SetAdmissionRegistration(" M-55 ")); // admissão concluída agora
        Assert.Equal(PositionStatus.AWAITING_FIRST_DAY, p.Status);
        Assert.False(p.SetAdmissionRegistration("M-55")); // correção: já estava concluída
        p.ConfirmFirstDay(D("2026-12-05"), "Ok", null, Now);

        Assert.Equal("M-55", p.EmployeeRegistration);
        Assert.Throws<BusinessRuleException>(() => p.SetAdmissionRegistration("M-56")); // preservada após a confirmação
    }

    [Fact]
    public void PositionApprovedBeforeTheCandidateRule_GetsTheCandidateRegisteredByRh()
    {
        var p = InAdmission("M-1");
        p.Candidates.Clear(); // aprovada antes do cadastro de candidatos

        Assert.True(p.CanRegisterMissingCandidate);
        Assert.Equal("employeeName", Assert.Throws<BusinessRuleException>(() =>
            p.ConfirmFirstDay(D("2026-12-05"), "Ok", null, Now)).Field);
        var c = p.CorrectCandidate(new CandidateData("João Pereira", D("1990-01-01"), CandidateSex.MALE, "11144477735"), D("2026-12-04"));

        Assert.Equal(D("2026-12-02"), c.ApprovedAt);
        p.ConfirmFirstDay(D("2026-12-05"), "Ok", null, Now);
        Assert.Equal("João Pereira", p.EmployeeName);
    }

    [Fact]
    public void AdmissionWithRegistration_GoesStraightToAwaitingFirstDay()
    {
        Assert.Equal(PositionStatus.AWAITING_FIRST_DAY, InAdmission("M-1").Status);
        Assert.Equal(PositionStatus.IN_ADMISSION, InAdmission().Status);
    }

    [Fact]
    public void NoShow_WorksInBothAdmissionStages_AndPauseKeepsTheStage()
    {
        var awaiting = InAdmission("M-1");
        awaiting.StartPause(Guid.NewGuid(), D("2026-12-04"));
        awaiting.EndPause(D("2026-12-04"));
        Assert.Equal(PositionStatus.AWAITING_FIRST_DAY, awaiting.Status);

        awaiting.AdmissionNoShow(Now);
        Assert.Equal(PositionStatus.RECRUITING, awaiting.Status);
        Assert.Null(awaiting.AdmissionRegistration);
    }
}
