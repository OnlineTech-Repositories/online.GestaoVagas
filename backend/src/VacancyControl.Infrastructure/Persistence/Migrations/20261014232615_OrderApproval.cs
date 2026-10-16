using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace VacancyControl.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class OrderApproval : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "approval_recorded_at",
                table: "orders",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "approval_recorded_by",
                table: "orders",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "approval_status",
                table: "orders",
                type: "text",
                nullable: false,
                defaultValue: "APPROVED");

            migrationBuilder.AddColumn<DateOnly>(
                name: "client_decision_date",
                table: "orders",
                type: "date",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "not_approved_reason",
                table: "orders",
                type: "character varying(1000)",
                maxLength: 1000,
                nullable: true);

            // Pedidos anteriores à aprovação do cliente já tinham o SLA contando desde o registro:
            // ficam "Aprovado", com a data de decisão igual à data de registro.
            migrationBuilder.Sql("UPDATE orders SET client_decision_date = registered_at WHERE client_decision_date IS NULL;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "approval_recorded_at",
                table: "orders");

            migrationBuilder.DropColumn(
                name: "approval_recorded_by",
                table: "orders");

            migrationBuilder.DropColumn(
                name: "approval_status",
                table: "orders");

            migrationBuilder.DropColumn(
                name: "client_decision_date",
                table: "orders");

            migrationBuilder.DropColumn(
                name: "not_approved_reason",
                table: "orders");
        }
    }
}
