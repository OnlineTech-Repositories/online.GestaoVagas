using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace VacancyControl.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class PositionAwaitingFirstDay : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Novo status "Aguardando 1º dia": admissão já registrada com matrícula (inclusive pausadas nessa etapa).
            migrationBuilder.Sql("""
                UPDATE positions SET status = 'AWAITING_FIRST_DAY'
                 WHERE status = 'IN_ADMISSION' AND admission_registration IS NOT NULL;
                UPDATE positions SET previous_status = 'AWAITING_FIRST_DAY'
                 WHERE status = 'PAUSED' AND previous_status = 'IN_ADMISSION' AND admission_registration IS NOT NULL;
                """);

        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                UPDATE positions SET status = 'IN_ADMISSION' WHERE status = 'AWAITING_FIRST_DAY';
                UPDATE positions SET previous_status = 'IN_ADMISSION' WHERE previous_status = 'AWAITING_FIRST_DAY';
                """);

        }
    }
}
