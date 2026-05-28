using System;
using System.Collections.Generic;

namespace DbMigrator.Core
{
    public class MigrationJob
    {
        public int Id { get; set; }
        public string JobName { get; set; }
        public string SourceConnectionString { get; set; }
        public string TargetConnectionString { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTime? LastRunAt { get; set; }
        public string PostMigrationScript { get; set; }
    }

    public class TableMapping
    {
        public int Id { get; set; }
        public int JobId { get; set; }
        public string SourceTableName { get; set; }
        public string TargetTableName { get; set; }
        public int ExecutionOrder { get; set; }
        public bool TruncateTarget { get; set; }
        public bool IsEnabled { get; set; }
        public List<ColumnMapping> Columns { get; set; } = new List<ColumnMapping>();
        public string PostMigrationScript { get; set; }
    }

    public class ColumnMapping
    {
        public int Id { get; set; }
        public int TableMappingId { get; set; }
        public string SourceColumnName { get; set; }
        public string TargetColumnName { get; set; }
        public string MappingType { get; set; } // Direct, Constant, Lookup, Expression, Ignore
        public string ConstantValue { get; set; }
        public string LookupTable { get; set; }
        public string LookupKeyColumn { get; set; }
        public string LookupValueColumn { get; set; }
        public string ExpressionSQL { get; set; }
    }

    public class MigrationLog
    {
        public int Id { get; set; }
        public int JobId { get; set; }
        public string TableName { get; set; }
        public DateTime StartTime { get; set; }
        public DateTime? EndTime { get; set; }
        public int TotalRows { get; set; }
        public int RowsMigrated { get; set; }
        public string Status { get; set; } // InProgress, Completed, Failed
        public string ErrorMessage { get; set; }
    }

    // ============================================================================
    // OBJECT MIGRATION MODELS (DDL Migrator)
    // ObjectMigrationItem.JobId sekarang merujuk ke dbo.MigrationJobs (bukan ObjectMigrationJobs)
    // Satu MigrationJob digunakan bersama oleh Data Migration & Object Migration.
    // ============================================================================

    public class ObjectMigrationItem
    {
        public int Id { get; set; }
        public int JobId { get; set; }   // FK → dbo.MigrationJobs.Id
        public string ObjectName { get; set; }
        public string ObjectType { get; set; } // PROCEDURE, FUNCTION, VIEW, TABLE, NATIVE_SQL
        public string NativeSqlScript { get; set; }
        public int ExecutionOrder { get; set; }
        public bool IsEnabled { get; set; }
    }

    public class ObjectMigrationBackup
    {
        public int Id { get; set; }
        public int ItemId { get; set; }
        public int Version { get; set; }
        public string BackupScript { get; set; }
        public DateTime BackedUpAt { get; set; }
    }

    public class ObjectMigrationLog
    {
        public int Id { get; set; }
        public int JobId { get; set; }
        public string ObjectName { get; set; }
        public string Action { get; set; } // BACKUP, DROP, CREATE, ALTER, NATIVE_SQL
        public string Status { get; set; } // Completed, Failed
        public DateTime ExecutedAt { get; set; }
        public string ErrorMessage { get; set; }
    }
}
