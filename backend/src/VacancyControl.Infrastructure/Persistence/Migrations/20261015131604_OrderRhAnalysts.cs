using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace VacancyControl.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class OrderRhAnalysts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "order_rh_analysts",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    order_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    assigned_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    assigned_by = table.Column<Guid>(type: "uuid", nullable: true),
                    removed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    removed_by = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_by = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    updated_by = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_order_rh_analysts", x => x.id);
                    table.ForeignKey(
                        name: "fk_order_rh_analysts_orders_order_id",
                        column: x => x.order_id,
                        principalTable: "orders",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ux_order_rh_analysts_active",
                table: "order_rh_analysts",
                columns: new[] { "order_id", "user_id" },
                unique: true,
                filter: "removed_at IS NULL");

            // RN-26: sem exclusão física; a remoção do analista é lógica (removed_at) e forma o histórico.
            migrationBuilder.Sql("""
                CREATE TRIGGER trg_order_rh_analysts_prevent_delete
                    BEFORE DELETE ON order_rh_analysts
                    FOR EACH ROW EXECUTE FUNCTION fn_prevent_delete();
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP TRIGGER IF EXISTS trg_order_rh_analysts_prevent_delete ON order_rh_analysts;");
            migrationBuilder.DropTable(
                name: "order_rh_analysts");
        }
    }
}
