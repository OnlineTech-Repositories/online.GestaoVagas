using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace VacancyControl.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Garantias no próprio banco: AuditLog append-only (seção 12) e sem exclusão física dos registros de negócio (RN-26).
    /// </summary>
    public partial class ProtectAuditAndPreventDeletes : Migration
    {
        private static readonly string[] NoDeleteTables =
        [
            "clients", "contracts", "contract_rates", "orders", "positions", "terminations", "pauses",
            "group_entities", "job_roles", "work_locations", "pause_reasons", "sla_targets", "system_parameters", "users"
        ];

        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                CREATE OR REPLACE FUNCTION fn_audit_logs_append_only() RETURNS trigger AS $$
                BEGIN
                    RAISE EXCEPTION 'audit_logs é somente inclusão: % não permitido', TG_OP;
                END;
                $$ LANGUAGE plpgsql;

                CREATE TRIGGER trg_audit_logs_append_only
                    BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_logs
                    FOR EACH STATEMENT EXECUTE FUNCTION fn_audit_logs_append_only();

                CREATE OR REPLACE FUNCTION fn_prevent_delete() RETURNS trigger AS $$
                BEGIN
                    RAISE EXCEPTION 'Exclusão física não permitida em % (RN-26)', TG_TABLE_NAME;
                END;
                $$ LANGUAGE plpgsql;
                """);

            foreach (var table in NoDeleteTables)
                migrationBuilder.Sql($"""
                    CREATE TRIGGER trg_{table}_prevent_delete
                        BEFORE DELETE ON {table}
                        FOR EACH ROW EXECUTE FUNCTION fn_prevent_delete();
                    """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            foreach (var table in NoDeleteTables)
                migrationBuilder.Sql($"DROP TRIGGER IF EXISTS trg_{table}_prevent_delete ON {table};");

            migrationBuilder.Sql("""
                DROP TRIGGER IF EXISTS trg_audit_logs_append_only ON audit_logs;
                DROP FUNCTION IF EXISTS fn_audit_logs_append_only();
                DROP FUNCTION IF EXISTS fn_prevent_delete();
                """);
        }
    }
}
