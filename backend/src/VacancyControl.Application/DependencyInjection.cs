using Microsoft.Extensions.DependencyInjection;
using VacancyControl.Application.Features.Catalogs;
using VacancyControl.Application.Features.Clients;
using VacancyControl.Application.Features.Dashboard;
using VacancyControl.Application.Features.Jobs;
using VacancyControl.Application.Features.Notifications;
using VacancyControl.Application.Features.Orders;
using VacancyControl.Application.Features.Parameters;
using VacancyControl.Application.Features.Positions;
using VacancyControl.Application.Features.Rates;
using VacancyControl.Application.Features.Terminations;
using VacancyControl.Application.Features.Users;

namespace VacancyControl.Application;

public static class DependencyInjection
{
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        services.AddScoped<ParameterService>();
        services.AddScoped<CatalogService>();
        services.AddScoped<ClientService>();
        services.AddScoped<ContractRateService>();
        services.AddScoped<NotificationService>();
        services.AddScoped<SnapshotService>();
        services.AddScoped<PositionQueryService>();
        services.AddScoped<PositionCommandService>();
        services.AddScoped<OrderService>();
        services.AddScoped<TerminationService>();
        services.AddScoped<DashboardService>();
        services.AddScoped<UserService>();
        services.AddScoped<DailyJobService>();
        return services;
    }
}
