import type { Knex } from "knex";

export const serversMigration = {
  up: async (connection: Knex) =>
    connection.schema.createTable("s3_servers", (table) => {
      table.string("id").primary();
      table.string("name").notNullable();
      table.text("endpoint_url").notNullable();
      table.string("region").notNullable();
      table.text("access_key").notNullable();
      table.text("secret_key").notNullable();
      table.boolean("force_path_style").notNullable().defaultTo(true);
      table.string("created_at").notNullable();
      table.string("updated_at").notNullable();
    }),
  down: async (connection: Knex) => connection.schema.dropTable("s3_servers"),
};
