using Npgsql;
using VacancyControl.Infrastructure.Persistence;

namespace VacancyControl.Tests;

/// <summary>A URL do banco que o Render entrega (postgresql://...) precisa virar connection string do Npgsql.</summary>
public class PostgresConnectionTests
{
    [Fact]
    public void RenderUrl_BecomesNpgsqlConnectionString()
    {
        var cs = new NpgsqlConnectionStringBuilder(
            PostgresConnection.Normalize("postgresql://vagas_user:s3nh%40F%3Arte@dpg-abc123-a/controle_vagas"));

        Assert.Equal("dpg-abc123-a", cs.Host);
        Assert.Equal(5432, cs.Port);
        Assert.Equal("controle_vagas", cs.Database);
        Assert.Equal("vagas_user", cs.Username);
        Assert.Equal("s3nh@F:rte", cs.Password); // caracteres especiais da senha chegam decodificados
    }

    [Fact]
    public void ExternalUrl_KeepsPortAndSslMode()
    {
        var cs = new NpgsqlConnectionStringBuilder(PostgresConnection.Normalize(
            "postgres://u:p@dpg-abc123-a.oregon-postgres.render.com:6543/db?sslmode=require"));

        Assert.Equal(6543, cs.Port);
        Assert.Equal(SslMode.Require, cs.SslMode);
    }

    [Fact]
    public void KeyValueFormat_PassesThrough()
    {
        const string value = "Host=localhost;Database=controle_vagas;Username=app";
        Assert.Equal(value, PostgresConnection.Normalize(value));
    }

    [Fact]
    public void Describe_NeverShowsThePassword()
    {
        var text = PostgresConnection.Describe(PostgresConnection.Normalize("postgresql://u:SegredoXyz@host/db"));
        Assert.DoesNotContain("SegredoXyz", text);
        Assert.Contains("host:5432/db", text);
    }
}
