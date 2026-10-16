namespace VacancyControl.Application.Common;

/// <summary>
/// Violação de regra de negócio. A mensagem é exibida ao usuário (pt-BR). <paramref name="field"/> indica,
/// quando houver, o campo do formulário (nome da propriedade JSON da requisição) que a tela deve marcar.
/// </summary>
public class BusinessRuleException(string message, string? field = null) : Exception(message)
{
    public string? Field { get; } = field;
}

public class NotFoundException(string message) : Exception(message);

/// <summary>Usuário autenticado sem permissão para a ação (HTTP 403).</summary>
public class ForbiddenException(string message = "Você não tem permissão para executar esta ação.") : Exception(message);
