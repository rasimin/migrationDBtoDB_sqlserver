using System;
using System.Collections.Generic;
using System.Linq;
using DbMigrator.Web.Models;

namespace DbMigrator.Web.Services
{
    public static class SchemaHelper
    {
        public static string GenerateComparableTableDdl(string schema, string table, List<SchemaColumnDto> columns, List<string> pkColumns)
        {
            var lines = columns.Select(c => "    " + FormatComparableColumnDefinition(c, includeName: true)).ToList();
            if (pkColumns.Count > 0)
            {
                lines.Add($"    CONSTRAINT [PK_{table}] PRIMARY KEY ({string.Join(", ", pkColumns.Select(c => $"[{c.Replace("]", "]]")}]"))})");
            }

            return $"CREATE TABLE [{schema.Replace("]", "]]")}].[{table.Replace("]", "]]")}] (\n{string.Join(",\n", lines)}\n);";
        }

        public static string FormatComparableColumnDefinition(SchemaColumnDto column, bool includeName)
        {
            var parts = new List<string>();
            if (includeName)
            {
                parts.Add($"[{column.Name.Replace("]", "]]")}]");
            }

            parts.Add(FormatComparableColumnType(column));
            if (column.IsIdentity) parts.Add("IDENTITY(1,1)");
            parts.Add(column.IsNullable ? "NULL" : "NOT NULL");
            if (!string.IsNullOrWhiteSpace(column.DefaultDefinition)) parts.Add($"DEFAULT {column.DefaultDefinition}");
            return string.Join(" ", parts);
        }

        public static string FormatComparableColumnType(SchemaColumnDto column)
        {
            var dataType = column.DataType?.ToLowerInvariant() ?? "";
            if (dataType is "varchar" or "char" or "varbinary" or "binary")
            {
                return column.MaxLength == -1 ? $"{dataType}(MAX)" : $"{dataType}({column.MaxLength})";
            }
            if (dataType is "nvarchar" or "nchar")
            {
                return column.MaxLength == -1 ? $"{dataType}(MAX)" : $"{dataType}({column.MaxLength / 2})";
            }
            if (dataType is "decimal" or "numeric")
            {
                return $"{dataType}({column.Precision},{column.Scale})";
            }
            if (dataType is "datetime2" or "datetimeoffset" or "time")
            {
                return $"{dataType}({column.Scale})";
            }

            return dataType;
        }

        public static string NormalizeDdl(string ddl)
        {
            if (string.IsNullOrWhiteSpace(ddl)) return string.Empty;
            return System.Text.RegularExpressions.Regex.Replace(ddl.Trim(), @"\s+", " ").ToLowerInvariant();
        }

        public static string EscapeHtml(string value)
        {
            return System.Net.WebUtility.HtmlEncode(value);
        }

        public static string QuoteMultipartSqlIdentifier(string name)
        {
            return string.Join(".", name.Split('.', StringSplitOptions.RemoveEmptyEntries)
                .Select(part => $"[{part.Replace("[", "").Replace("]", "]]")}]"));
        }
    }
}
