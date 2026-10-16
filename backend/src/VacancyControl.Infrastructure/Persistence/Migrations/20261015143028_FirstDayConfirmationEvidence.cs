using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace VacancyControl.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class FirstDayConfirmationEvidence : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "admission_registration",
                table: "positions",
                type: "character varying(50)",
                maxLength: 50,
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "first_day_confirmed_at",
                table: "positions",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "first_day_confirmed_by",
                table: "positions",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "first_day_justification",
                table: "positions",
                type: "character varying(2000)",
                maxLength: 2000,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "evidence_files",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    content = table.Column<byte[]>(type: "bytea", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_evidence_files", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "position_evidences",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    position_id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<string>(type: "text", nullable: false),
                    file_name = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    content_type = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    size_bytes = table.Column<long>(type: "bigint", nullable: false),
                    storage_key = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_by = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    updated_by = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_position_evidences", x => x.id);
                    table.ForeignKey(
                        name: "fk_position_evidences_positions_position_id",
                        column: x => x.position_id,
                        principalTable: "positions",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_position_evidences_position_id",
                table: "position_evidences",
                column: "position_id");

            // RN-26: sem exclusão física das evidências (metadados e conteúdo).
            foreach (var table in new[] { "position_evidences", "evidence_files" })
                migrationBuilder.Sql($"""
                    CREATE TRIGGER trg_{table}_prevent_delete
                        BEFORE DELETE ON {table}
                        FOR EACH ROW EXECUTE FUNCTION fn_prevent_delete();
                    """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            foreach (var table in new[] { "position_evidences", "evidence_files" })
                migrationBuilder.Sql($"DROP TRIGGER IF EXISTS trg_{table}_prevent_delete ON {table};");

            migrationBuilder.DropTable(
                name: "evidence_files");

            migrationBuilder.DropTable(
                name: "position_evidences");

            migrationBuilder.DropColumn(
                name: "admission_registration",
                table: "positions");

            migrationBuilder.DropColumn(
                name: "first_day_confirmed_at",
                table: "positions");

            migrationBuilder.DropColumn(
                name: "first_day_confirmed_by",
                table: "positions");

            migrationBuilder.DropColumn(
                name: "first_day_justification",
                table: "positions");
        }
    }
}
