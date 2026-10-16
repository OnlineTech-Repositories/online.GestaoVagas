using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace VacancyControl.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class OrderJobconvoPublication : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "jobconvo_code",
                table: "orders",
                type: "character varying(100)",
                maxLength: 100,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "jobconvo_notes",
                table: "orders",
                type: "character varying(2000)",
                maxLength: 2000,
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "jobconvo_published",
                table: "orders",
                type: "boolean",
                nullable: true);

            migrationBuilder.AddColumn<DateOnly>(
                name: "jobconvo_published_at",
                table: "orders",
                type: "date",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "jobconvo_recorded_at",
                table: "orders",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "jobconvo_recorded_by",
                table: "orders",
                type: "uuid",
                nullable: true);

            // A publicação no JobConvo passa da posição para o pedido: cada pedido herda o código da posição que
            // entrou primeiro em recrutamento (data da publicação = abertura no JobConvo, ou o registro do pedido).
            migrationBuilder.Sql("""
                UPDATE orders o
                   SET jobconvo_published = TRUE,
                       jobconvo_code = s.jobconvo_code,
                       jobconvo_published_at = COALESCE(s.jobconvo_opened_at, o.registered_at)
                  FROM (SELECT DISTINCT ON (order_id) order_id, jobconvo_code, jobconvo_opened_at
                          FROM positions
                         WHERE jobconvo_code IS NOT NULL
                         ORDER BY order_id, jobconvo_opened_at NULLS LAST, sequence) s
                 WHERE o.id = s.order_id;
                """);

            migrationBuilder.DropColumn(
                name: "jobconvo_code",
                table: "positions");

            migrationBuilder.DropColumn(
                name: "jobconvo_opened_at",
                table: "positions");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "jobconvo_code",
                table: "orders");

            migrationBuilder.DropColumn(
                name: "jobconvo_notes",
                table: "orders");

            migrationBuilder.DropColumn(
                name: "jobconvo_published",
                table: "orders");

            migrationBuilder.DropColumn(
                name: "jobconvo_published_at",
                table: "orders");

            migrationBuilder.DropColumn(
                name: "jobconvo_recorded_at",
                table: "orders");

            migrationBuilder.DropColumn(
                name: "jobconvo_recorded_by",
                table: "orders");

            migrationBuilder.AddColumn<string>(
                name: "jobconvo_code",
                table: "positions",
                type: "character varying(100)",
                maxLength: 100,
                nullable: true);

            migrationBuilder.AddColumn<DateOnly>(
                name: "jobconvo_opened_at",
                table: "positions",
                type: "date",
                nullable: true);
        }
    }
}
