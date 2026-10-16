using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace VacancyControl.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class PositionSlots : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "cycle",
                table: "positions",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "slot_number",
                table: "positions",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            // Vaga = número das vagas novas na ordem de criação; cada reposição herda a vaga da origem e soma um ciclo.
            migrationBuilder.Sql("""
                WITH RECURSIVE news AS (
                    SELECT id, ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY sequence) AS slot
                      FROM positions WHERE demand_type = 'NEW'
                ), chain AS (
                    SELECT n.id, n.slot, 1 AS cycle FROM news n
                    UNION ALL
                    SELECT p.id, c.slot, c.cycle + 1 FROM positions p JOIN chain c ON p.origin_position_id = c.id
                )
                UPDATE positions SET slot_number = chain.slot, cycle = chain.cycle FROM chain WHERE positions.id = chain.id;
                """);

            migrationBuilder.CreateIndex(
                name: "ix_positions_order_id_slot_number_cycle",
                table: "positions",
                columns: new[] { "order_id", "slot_number", "cycle" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_positions_order_id_slot_number_cycle",
                table: "positions");

            migrationBuilder.DropColumn(
                name: "cycle",
                table: "positions");

            migrationBuilder.DropColumn(
                name: "slot_number",
                table: "positions");
        }
    }
}
