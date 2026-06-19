using System;
using System.Collections.Generic;

namespace DbMigrator.Web.Models
{
    public class TestConnectionRequest
    {
        public string ConnectionString { get; set; }
    }

    public class ReorderItemDto
    {
        public int Id { get; set; }
        public int ExecutionOrder { get; set; }
    }

    public class SchemaComparisonSummaryDto
    {
        public int SourceCount { get; set; }
        public int TargetCount { get; set; }
        public int MissingCount { get; set; }
        public int MismatchCount { get; set; }
        public int OutdatedCount { get; set; }
    }

    public class SchemaComparisonItemDto
    {
        public string Name { get; set; }
        public string Type { get; set; }
        public string Status { get; set; }
        public string Info { get; set; }
        public string SourceDdl { get; set; }
        public string TargetDdl { get; set; }
        public ColumnSyncPlanDto ColumnSync { get; set; }
    }

    public class ColumnSyncPlanDto
    {
        public List<ColumnPreviewDto> Before { get; set; } = new();
        public List<ColumnPreviewDto> After { get; set; } = new();
        public string Sql { get; set; }
    }

    public class ColumnPreviewDto
    {
        public string Name { get; set; }
        public string Type { get; set; }
        public bool IsNew { get; set; }
    }

    public class SchemaColumnDto
    {
        public string Name { get; set; }
        public string DataType { get; set; }
        public short MaxLength { get; set; }
        public byte Precision { get; set; }
        public byte Scale { get; set; }
        public bool IsNullable { get; set; }
        public bool IsIdentity { get; set; }
        public string DefaultDefinition { get; set; }
        public int Ordinal { get; set; }
    }

    public class ComparableDbObject
    {
        public string Name { get; set; }
        public string Type { get; set; }
        public string DisplayType { get; set; }
        public string Ddl { get; set; }
        public List<SchemaColumnDto> Columns { get; set; } = new();
        public string Key => $"{DisplayType}:{Name}";
    }

    public class ExportJobDto
    {
        public string JobName { get; set; }
        public string SourceConnectionString { get; set; }
        public string TargetConnectionString { get; set; }
        public string PostMigrationScript { get; set; }
        public List<ExportTableMappingDto> TableMappings { get; set; } = new();
    }

    public class ExportTableMappingDto
    {
        public string SourceTableName { get; set; }
        public string TargetTableName { get; set; }
        public int ExecutionOrder { get; set; }
        public bool TruncateTarget { get; set; }
        public bool IsEnabled { get; set; }
        public string MappingMode { get; set; }
        public string NativeSqlScript { get; set; }
        public string PostMigrationScript { get; set; }
        public string WhereClause { get; set; }
        public List<ExportColumnMappingDto> Columns { get; set; } = new();
    }

    public class ExportColumnMappingDto
    {
        public string SourceColumnName { get; set; }
        public string TargetColumnName { get; set; }
        public string MappingType { get; set; }
        public string ConstantValue { get; set; }
        public string LookupTable { get; set; }
        public string LookupKeyColumn { get; set; }
        public string LookupValueColumn { get; set; }
        public string ExpressionSQL { get; set; }
        public string IfNullAction { get; set; }
        public string IfNullParam { get; set; }
    }

    public class RestoreRequest
    {
        public string BackupFilename { get; set; }
        public string RestoreDbName { get; set; }
    }

    public class GeneralAppSettings
    {
        public string AppimsBackupPath { get; set; } = string.Empty;
    }

    public class SavedConnection
    {
        public int Id { get; set; }
        public string ConnectionName { get; set; }
        public string ServerName { get; set; }
        public string Authentication { get; set; }
        public string Login { get; set; }
        public string Password { get; set; }
        public DateTime CreatedAt { get; set; }
    }

    public class QueryConnectRequest
    {
        public string ServerName { get; set; }
        public string Authentication { get; set; } // "SQL" or "Windows"
        public string Login { get; set; }
        public string Password { get; set; }
    }

    public class QuerySchemaRequest
    {
        public string ServerName { get; set; }
        public string Authentication { get; set; }
        public string Login { get; set; }
        public string Password { get; set; }
        public string Database { get; set; }
    }

    public class QueryGenerateInsertsRequest
    {
        public string ServerName { get; set; }
        public string Authentication { get; set; }
        public string Login { get; set; }
        public string Password { get; set; }
        public string Database { get; set; }
        public string TableName { get; set; }
        public string WhereClause { get; set; }
        public bool UseVariables { get; set; }
    }

    public class QueryExecuteRequest
    {
        public string ServerName { get; set; }
        public string Authentication { get; set; }
        public string Login { get; set; }
        public string Password { get; set; }
        public string Database { get; set; }
        public string QueryText { get; set; }
    }

    public class QueryResultTable
    {
        public List<string> Headers { get; set; } = new List<string>();
        public List<List<object>> Rows { get; set; } = new List<List<object>>();
        public bool IsTruncated { get; set; } = false;
    }

    public class QuerySchemaObjectsRequest
    {
        public string ServerName { get; set; }
        public string Authentication { get; set; }
        public string Login { get; set; }
        public string Password { get; set; }
        public string Database { get; set; }
        public string ObjectType { get; set; } // ALL, TABLE, VIEW, PROCEDURE, FUNCTION
        public string SearchTerm { get; set; }
        public bool SearchInContent { get; set; }
    }

    public class QuerySchemaDefinitionRequest
    {
        public string ServerName { get; set; }
        public string Authentication { get; set; }
        public string Login { get; set; }
        public string Password { get; set; }
        public string Database { get; set; }
        public string ObjectName { get; set; } // dbo.MyTable
        public string ObjectType { get; set; } // TABLE, VIEW, PROCEDURE, FUNCTION
    }

    public class SsrsCredentialsDto
    {
        public string Url { get; set; } = "";
        public string Username { get; set; } = "";
        public string Password { get; set; } = "";
        public string Domain { get; set; } = "";
    }

    public class SsrsBrowseRequestDto : SsrsCredentialsDto
    {
        public string Path { get; set; } = "/";
    }

    public class SsrsCreateFolderRequestDto : SsrsCredentialsDto
    {
        public string ParentPath { get; set; } = "/";
        public string FolderName { get; set; } = "";
    }

    public class SsrsDeleteItemRequestDto : SsrsCredentialsDto
    {
        public string Path { get; set; } = "";
    }

    public class SsrsDownloadRequestDto : SsrsCredentialsDto
    {
        public string Path { get; set; } = "";
        public string TypeName { get; set; } = "";
    }

    public class DataSourceDefinitionDto
    {
        public string Extension { get; set; } = "SQL";
        public string ConnectString { get; set; } = "";
        public string CredentialRetrieval { get; set; } = "Store";
        public bool WindowsCredentials { get; set; } = false;
        public string UserName { get; set; } = "";
        public string Password { get; set; } = "";
    }

    public class SsrsSetDataSourceRequestDto : SsrsCredentialsDto
    {
        public string Path { get; set; } = "";
        public DataSourceDefinitionDto Definition { get; set; } = new();
    }

    public class SsrsTestDataSourceConnectionRequestDto
    {
        public string ConnectString { get; set; } = "";
        public string CredentialRetrieval { get; set; } = "Store";
        public bool WindowsCredentials { get; set; } = false;
        public string UserName { get; set; } = "";
        public string Password { get; set; } = "";
    }

    public class CatalogItemDto
    {
        public string Name { get; set; } = "";
        public string Path { get; set; } = "";
        public string TypeName { get; set; } = "";
    }

    public class SavedSsrsConnection
    {
        public int Id { get; set; }
        public string ConnectionName { get; set; } = "";
        public string Url { get; set; } = "";
        public string Username { get; set; } = "";
        public string Password { get; set; } = "";
        public string Domain { get; set; } = "";
        public DateTime CreatedAt { get; set; }
    }

    public class QueryExecutionLog
    {
        public int Id { get; set; }
        public string ServerName { get; set; } = "";
        public string DatabaseName { get; set; } = "";
        public string QueryText { get; set; } = "";
        public string Status { get; set; } = "";
        public long? ExecutionTimeMs { get; set; }
        public string ErrorMessage { get; set; }
        public string ResponseMessages { get; set; }
        public DateTime ExecutedAt { get; set; }
    }
}
