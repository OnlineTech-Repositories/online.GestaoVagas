using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace VacancyControl.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ContractingUnitAndCode : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "contracting_unit_id",
                table: "contracts",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "ix_contracts_contracting_unit_id",
                table: "contracts",
                column: "contracting_unit_id");

            migrationBuilder.CreateIndex(
                name: "ix_contracts_name",
                table: "contracts",
                column: "name",
                unique: true);

            migrationBuilder.AddForeignKey(
                name: "fk_contracts_work_locations_contracting_unit_id",
                table: "contracts",
                column: "contracting_unit_id",
                principalTable: "work_locations",
                principalColumn: "id",
                onDelete: ReferentialAction.Restrict);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "fk_contracts_work_locations_contracting_unit_id",
                table: "contracts");

            migrationBuilder.DropIndex(
                name: "ix_contracts_contracting_unit_id",
                table: "contracts");

            migrationBuilder.DropIndex(
                name: "ix_contracts_name",
                table: "contracts");

            migrationBuilder.DropColumn(
                name: "contracting_unit_id",
                table: "contracts");
        }
    }
}
