using Microsoft.Extensions.Configuration;
using Npgsql;

namespace VacancyControl.Infrastructure.Persistence;

/// <summary>
/// Resolve a conexão PostgreSQL a partir da configuração, aceitando os dois formatos em uso.
///
/// O Render (e a maioria das plataformas) entrega o banco como URL — postgresql://usuario:senha@host:5432/banco —,
/// e o Npgsql só aceita o formato chave=valor. Na primeira publicação isso obrigava a desmontar a URL à mão no painel,
/// e um caractere especial na senha bastava para a API não subir. Aqui a URL é convertida, venha ela em
/// ConnectionStrings__Default ou em DATABASE_URL.
/// </summary>
public static class PostgresConnection
{
    public static string? Resolve(IConfiguration configuration)
    {
        var raw = configuration.GetConnectionString("Default") is { Length: > 0 } cs ? cs : configuration["DATABASE_URL"];
        return string.IsNullOrWhiteSpace(raw) ? null : Normalize(raw.Trim());
    }

    /// <summary>Converte uma URL postgres:// em connection string do Npgsql; o formato chave=valor passa como está.</summary>
    public static string Normalize(string value)
    {
        if (!value.StartsWith("postgres://", StringComparison.OrdinalIgnoreCase)
            && !value.StartsWith("postgresql://", StringComparison.OrdinalIgnoreCase))
            return value;

        var uri = new Uri(value);
        var builder = new NpgsqlConnectionStringBuilder
        {
            Host = uri.Host,
            Port = uri.Port > 0 ? uri.Port : 5432,
            Database = Uri.UnescapeDataString(uri.AbsolutePath.TrimStart('/')),
        };
        var userInfo = uri.UserInfo.Split(':', 2);
        builder.Username = Uri.UnescapeDataString(userInfo[0]);
        if (userInfo.Length > 1) builder.Password = Uri.UnescapeDataString(userInfo[1]);

        // Parâmetros da URL (?sslmode=require etc.) viram chaves da connection string.
        foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var kv = pair.Split('=', 2);
            var key = Uri.UnescapeDataString(kv[0]);
            var val = kv.Length > 1 ? Uri.UnescapeDataString(kv[1]) : "";
            builder[key.Equals("sslmode", StringComparison.OrdinalIgnoreCase) ? "SSL Mode" : key] = val;
        }
        return builder.ConnectionString;
    }

    /// <summary>Destino da conexão para o log de partida — nunca a senha.</summary>
    public static string Describe(string connectionString)
    {
        var b = new NpgsqlConnectionStringBuilder(connectionString);
        return $"{b.Host}:{b.Port}/{b.Database} (usuário {b.Username}, SSL {b.SslMode})";
    }
}
