using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;
using static VacancyControl.Tests.Builders;

namespace VacancyControl.Tests;

/// <summary>Candidato selecionado por posição: dados validados, correção e histórico de desistências.</summary>
public class CandidateTests
{
    private static readonly DateOnly Today = D("2026-12-02");

    private static Position Recruiting()
    {
        var p = NewPosition(Order());
        Recruit(p);
        return p;
    }

    [Theory]
    [InlineData("529.982.247-25", true)]
    [InlineData("52998224725", true)]
    [InlineData("529.982.247-24", false)]
    [InlineData("111.111.111-11", false)]
    [InlineData("1234", false)]
    public void Cpf_ChecksTheVerifierDigits(string cpf, bool valid) => Assert.Equal(valid, Cpf.IsValid(cpf));

    [Fact]
    public void Cpf_IsMaskedForRestrictedViewers() => Assert.Equal("***.982.247-**", Cpf.Mask("529.982.247-25"));

    [Fact]
    public void Approve_StoresTheCandidate_PerPosition()
    {
        var p = Recruiting();

        var c = p.ApproveCandidate(D("2026-12-02"), new CandidateData("  Maria   da Silva ", D("1995-04-10"), CandidateSex.FEMALE,
            "529.982.247-25"), Today);

        Assert.Same(c, p.ActiveCandidate);
        Assert.Equal("Maria da Silva", c.FullName);
        Assert.Equal("52998224725", c.Cpf);
        Assert.Equal(PositionStatus.CANDIDATE_APPROVED, p.Status);
    }

    [Theory]
    [InlineData("", "1995-04-10", CandidateSex.FEMALE, "52998224725", "fullName")]
    [InlineData("Maria", null, CandidateSex.FEMALE, "52998224725", "birthDate")]
    [InlineData("Maria", "2026-12-03", CandidateSex.FEMALE, "52998224725", "birthDate")]
    [InlineData("Maria", "1995-04-10", null, "52998224725", "sex")]
    [InlineData("Maria", "1995-04-10", CandidateSex.MALE, "52998224724", "cpf")]
    [InlineData("Maria", "1995-04-10", CandidateSex.MALE, null, "cpf")]
    public void Approve_ValidatesEachField(string name, string? birth, CandidateSex? sex, string? cpf, string field)
    {
        var p = Recruiting();

        var ex = Assert.Throws<BusinessRuleException>(() =>
            p.ApproveCandidate(Today, new CandidateData(name, birth is null ? null : D(birth), sex, cpf), Today));

        Assert.Equal(field, ex.Field);
        Assert.Equal(PositionStatus.RECRUITING, p.Status);
        Assert.Empty(p.Candidates);
    }

    [Fact]
    public void Correct_ChangesTheActiveCandidate()
    {
        var p = Recruiting();
        p.ApproveCandidate(Today, Candidate(), Today);

        p.CorrectCandidate(new CandidateData("Maria da Silva Santos", D("1995-04-11"), CandidateSex.NOT_INFORMED, "52998224725"), Today);

        Assert.Equal("Maria da Silva Santos", p.ActiveCandidate!.FullName);
        Assert.Equal(CandidateSex.NOT_INFORMED, p.ActiveCandidate.Sex);
        Assert.Single(p.Candidates);
    }

    [Fact]
    public void Withdrawal_KeepsThePreviousCandidate_AndFreesThePosition()
    {
        var p = Recruiting();
        p.ApproveCandidate(Today, Candidate(), Today);

        p.CandidateWithdrew(DateTimeOffset.UtcNow);
        p.ApproveCandidate(Today, new CandidateData("João Pereira", D("1990-01-01"), CandidateSex.MALE, "11144477735"), Today);
        p.RegisterAdmission(Today);
        p.AdmissionNoShow(DateTimeOffset.UtcNow);

        Assert.Null(p.ActiveCandidate);
        Assert.Equal(["Candidato desistiu", "Admitido não compareceu"], p.Candidates.Select(c => c.WithdrawalReason));
        Assert.Throws<BusinessRuleException>(() => p.CorrectCandidate(Candidate(), Today));
    }
}
