using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace VacancyControl.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class PositionCandidates : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "candidates",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    position_id = table.Column<Guid>(type: "uuid", nullable: false),
                    full_name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    birth_date = table.Column<DateOnly>(type: "date", nullable: false),
                    sex = table.Column<string>(type: "text", nullable: false),
                    cpf = table.Column<string>(type: "character(11)", fixedLength: true, maxLength: 11, nullable: false),
                    approved_at = table.Column<DateOnly>(type: "date", nullable: false),
                    withdrawn_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    withdrawal_reason = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_by = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    updated_by = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_candidates", x => x.id);
                    table.ForeignKey(
                        name: "fk_candidates_positions_position_id",
                        column: x => x.position_id,
                        principalTable: "positions",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_candidates_cpf",
                table: "candidates",
                column: "cpf");

            migrationBuilder.CreateIndex(
                name: "ux_candidates_one_active",
                table: "candidates",
                column: "position_id",
                unique: true,
                filter: "withdrawn_at IS NULL");

            // RN-26: sem exclusão física; o candidato que sai da posição fica registrado (withdrawn_at).
            migrationBuilder.Sql("""
                CREATE TRIGGER trg_candidates_prevent_delete
                    BEFORE DELETE ON candidates
                    FOR EACH ROW EXECUTE FUNCTION fn_prevent_delete();
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP TRIGGER IF EXISTS trg_candidates_prevent_delete ON candidates;");
            migrationBuilder.DropTable(
                name: "candidates");
        }
    }
}
