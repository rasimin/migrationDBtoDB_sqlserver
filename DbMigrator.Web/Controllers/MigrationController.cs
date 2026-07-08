using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;
using DbMigrator.Core;
using DbMigrator.Web.Models;
using DbMigrator.Web.Services;

namespace DbMigrator.Web.Controllers
{
    [ApiController]
    public class MigrationController : ControllerBase
    {
        private readonly MigrationService _migrationService;
        private readonly IWebHostEnvironment _env;
        private readonly IConfiguration _config;

        public MigrationController(MigrationService migrationService, IWebHostEnvironment env, IConfiguration config)
        {
            _migrationService = migrationService;
            _env = env;
            _config = config;
        }

        #region Jobs

        [HttpGet("/api/jobs")]
        public async Task<IActionResult> GetJobs()
        {
            try
            {
                var jobs = await _migrationService.GetJobsAsync();
                return Ok(jobs);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpGet("/api/jobs/{id:int}")]
        public async Task<IActionResult> GetJobById(int id)
        {
            try
            {
                var job = await _migrationService.GetJobByIdAsync(id);
                if (job == null) return NotFound($"Job {id} tidak ditemukan");
                return Ok(job);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("/api/jobs")]
        public async Task<IActionResult> SaveJob([FromBody] MigrationJob job)
        {
            try
            {
                var id = await _migrationService.SaveJobAsync(job);
                job.Id = id;
                return Ok(job);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpDelete("/api/jobs/{id:int}")]
        [HttpPost("/api/jobs/{id:int}/delete")]
        public async Task<IActionResult> DeleteJob(int id)
        {
            try
            {
                var success = await _migrationService.DeleteJobAsync(id);
                if (!success) return NotFound($"Job {id} tidak ditemukan");
                return Ok();
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("/api/jobs/test-connection")]
        public async Task<IActionResult> TestConnection([FromBody] TestConnectionRequest request)
        {
            try
            {
                await _migrationService.TestConnectionAsync(request?.ConnectionString);
                return Ok(new { Success = true, Message = "Koneksi berhasil terhubung!" });
            }
            catch (Exception ex)
            {
                return Ok(new { Success = false, Message = $"Gagal terhubung: {ex.Message}" });
            }
        }

        #endregion

        #region Table Mappings

        [HttpGet("/api/mappings/tables/{jobId:int}")]
        public async Task<IActionResult> GetTableMappings(int jobId)
        {
            try
            {
                var mappings = await _migrationService.GetTableMappingsAsync(jobId);
                return Ok(mappings);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("/api/mappings/tables/{jobId:int}/reorder")]
        public async Task<IActionResult> ReorderTableMappings(int jobId, [FromBody] List<ReorderItemDto> items)
        {
            try
            {
                await _migrationService.ReorderTableMappingsAsync(jobId, items);
                return Ok(new { Message = "Urutan pemetaan tabel berhasil diperbarui." });
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("/api/mappings/tables")]
        public async Task<IActionResult> SaveTableMapping([FromBody] TableMapping mapping)
        {
            try
            {
                var result = await _migrationService.SaveTableMappingAsync(mapping);
                if (mapping.Id > 0)
                {
                    return Ok(result);
                }
                return Created($"/api/mappings/tables/{result.Id}", result);
            }
            catch (InvalidOperationException ex)
            {
                return BadRequest(ex.Message);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpDelete("/api/mappings/tables/{id:int}")]
        public async Task<IActionResult> DeleteTableMapping(int id)
        {
            try
            {
                await _migrationService.DeleteTableMappingAsync(id);
                return Ok();
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        #endregion

        #region Column Mappings

        [HttpGet("/api/mappings/columns/{tableMappingId:int}")]
        public async Task<IActionResult> GetColumnMappings(int tableMappingId)
        {
            try
            {
                var columns = await _migrationService.GetColumnMappingsAsync(tableMappingId);
                return Ok(columns);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("/api/mappings/columns/{tableMappingId:int}")]
        public async Task<IActionResult> SaveColumnMappings(int tableMappingId, [FromBody] List<ColumnMapping> columns)
        {
            try
            {
                await _migrationService.SaveColumnMappingsAsync(tableMappingId, columns);
                return Ok(columns);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        #endregion

        #region SP Generator

        [HttpGet("/api/mappings/tables/{id:int}/generate-sp")]
        public async Task<IActionResult> GenerateSp(int id)
        {
            try
            {
                var result = await _migrationService.GenerateSpAsync(id);
                return Ok(new { SpName = result.SpName, SqlScript = result.SqlScript });
            }
            catch (ArgumentException ex)
            {
                return NotFound(ex.Message);
            }
            catch (InvalidOperationException ex)
            {
                return BadRequest(ex.Message);
            }
            catch (Exception ex)
            {
                return BadRequest(ex.Message);
            }
        }

        #endregion

        #region DB Metadata

        [HttpGet("/api/db/tables")]
        public async Task<IActionResult> GetDbTables([FromQuery] int jobId, [FromQuery] string dbType)
        {
            try
            {
                var tables = await _migrationService.GetDbTablesAsync(jobId, dbType);
                return Ok(tables);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpGet("/api/db/columns")]
        public async Task<IActionResult> GetDbColumns([FromQuery] int jobId, [FromQuery] string dbType, [FromQuery] string tableName)
        {
            try
            {
                var columns = await _migrationService.GetDbColumnsAsync(jobId, dbType, tableName);
                return Ok(columns);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpGet("/api/db/schema-comparison")]
        public async Task<IActionResult> CompareSchema([FromQuery] int jobId)
        {
            try
            {
                var result = await _migrationService.CompareSchemaAsync(jobId);
                return Ok(result);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpGet("/api/db/schema")]
        public async Task<IActionResult> GetEntireSchema([FromQuery] int jobId, [FromQuery] string dbType)
        {
            try
            {
                var schema = await _migrationService.GetEntireSchemaAsync(jobId, dbType);
                return Ok(schema);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        #endregion

        #region Run & Cancel Migration

        [HttpPost("/api/jobs/{id:int}/run")]
        public IActionResult RunJob(int id, [FromQuery] int? mappingId, [FromQuery] bool checkConstraints)
        {
            try
            {
                _migrationService.RunMigrationJob(id, mappingId, checkConstraints);
                return Accepted($"/api/jobs/{id}/run", new { Message = "Proses migrasi telah dimulai di background." });
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("/api/jobs/{id:int}/cancel")]
        public IActionResult CancelJob(int id)
        {
            try
            {
                var success = _migrationService.CancelMigrationJob(id);
                if (success)
                {
                    return Ok(new { Message = "Proses pembatalan berhasil dipicu." });
                }
                return NotFound($"Tidak ada proses migrasi aktif yang ditemukan untuk Job {id}");
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        #endregion

        #region AppIMS Backup & Restore

        [HttpGet("/api/appims/backup-settings")]
        public async Task<IActionResult> GetAppimsSettings()
        {
            try
            {
                var settings = await _migrationService.GetAppimsSettingsAsync(_env.ContentRootPath);
                string serverName = "Unknown Server";
                try
                {
                    var builder = new SqlConnectionStringBuilder(_config.GetConnectionString("ConfigDb"));
                    serverName = builder.DataSource;
                }
                catch { }
                return Ok(new { Success = true, AppimsBackupPath = settings.AppimsBackupPath, Server = serverName });
            }
            catch (Exception ex)
            {
                return Ok(new { Success = false, Message = ex.Message, AppimsBackupPath = "", Server = "Unknown Server" });
            }
        }

        [HttpPost("/api/appims/backup-settings")]
        public async Task<IActionResult> SaveAppimsSettings([FromBody] GeneralAppSettings settings)
        {
            try
            {
                await _migrationService.SaveAppimsSettingsAsync(settings, _env.ContentRootPath);
                return Ok(new { Success = true, Message = "Pengaturan berhasil disimpan ke app-config.json!" });
            }
            catch (Exception ex)
            {
                return Ok(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("/api/appims/backup")]
        public async Task<IActionResult> BackupAppims()
        {
            try
            {
                var filename = await _migrationService.BackupAppimsDbAsync(_env.ContentRootPath);
                var dbName = new SqlConnectionStringBuilder(_config.GetConnectionString("ConfigDb")).InitialCatalog;
                return Ok(new { Success = true, Message = $"Database AppIMS '{dbName}' berhasil di-backup ke file '{filename}'!", Filename = filename });
            }
            catch (Exception ex)
            {
                return Ok(new { Success = false, Message = $"Gagal mem-backup database AppIMS: {ex.Message}" });
            }
        }

        [HttpGet("/api/appims/backup-files")]
        public async Task<IActionResult> GetAppimsBackupFiles()
        {
            try
            {
                var files = await _migrationService.GetAppimsBackupFilesAsync(_env.ContentRootPath);
                return Ok(new { Success = true, Files = files });
            }
            catch (Exception ex)
            {
                return Ok(new { Success = false, Message = $"Gagal mendeteksi file backup AppIMS di server database: {ex.Message}" });
            }
        }

        [HttpPost("/api/appims/restore")]
        public async Task<IActionResult> RestoreAppims([FromBody] RestoreRequest request)
        {
            try
            {
                await _migrationService.RestoreAppimsDbAsync(request, _env.ContentRootPath);
                var restoreDbName = string.IsNullOrEmpty(request.RestoreDbName) 
                    ? new SqlConnectionStringBuilder(_config.GetConnectionString("ConfigDb")).InitialCatalog 
                    : request.RestoreDbName.Trim();
                return Ok(new { Success = true, Message = $"Database AppIMS '{restoreDbName}' berhasil di-restore dengan sukses!" });
            }
            catch (Exception ex)
            {
                return Ok(new { Success = false, Message = $"Gagal me-restore database AppIMS: {ex.Message}" });
            }
        }

        #endregion

        #region Job DB Backup & Restore

        [HttpPost("/api/jobs/{id:int}/backup")]
        public async Task<IActionResult> BackupJobDb(int id)
        {
            try
            {
                var filename = await _migrationService.BackupJobDbAsync(id);
                var job = await _migrationService.GetJobByIdAsync(id);
                var targetDb = new SqlConnectionStringBuilder(job.TargetConnectionString).InitialCatalog;
                return Ok(new { Success = true, Message = $"Database '{targetDb}' berhasil di-backup ke file '{filename}'!", Filename = filename });
            }
            catch (Exception ex)
            {
                return Ok(new { Success = false, Message = $"Gagal mem-backup database: {ex.Message}" });
            }
        }

        [HttpGet("/api/jobs/{id:int}/backup-files")]
        public async Task<IActionResult> GetJobBackupFiles(int id)
        {
            try
            {
                var files = await _migrationService.GetJobBackupFilesAsync(id);
                return Ok(new { Success = true, Files = files });
            }
            catch (Exception ex)
            {
                return Ok(new { Success = false, Message = $"Gagal mendeteksi file backup di server database: {ex.Message}" });
            }
        }

        [HttpPost("/api/jobs/{id:int}/restore")]
        public async Task<IActionResult> RestoreJobDb(int id, [FromBody] RestoreRequest request)
        {
            try
            {
                await _migrationService.RestoreJobDbAsync(id, request);
                var job = await _migrationService.GetJobByIdAsync(id);
                var targetDb = new SqlConnectionStringBuilder(job.TargetConnectionString).InitialCatalog;
                var restoreDbName = string.IsNullOrEmpty(request.RestoreDbName) ? targetDb : request.RestoreDbName.Trim();
                return Ok(new { Success = true, Message = $"Database '{restoreDbName}' berhasil di-restore dengan sukses!" });
            }
            catch (Exception ex)
            {
                return Ok(new { Success = false, Message = $"Gagal me-restore database: {ex.Message}" });
            }
        }

        #endregion

        #region Import & Export

        [HttpGet("/api/jobs/{id:int}/export")]
        public async Task<IActionResult> ExportJob(int id)
        {
            try
            {
                var export = await _migrationService.ExportJobAsync(id);
                return Ok(export);
            }
            catch (ArgumentException)
            {
                return NotFound($"Job {id} tidak ditemukan");
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("/api/jobs/import")]
        public async Task<IActionResult> ImportJob([FromBody] ExportJobDto import)
        {
            try
            {
                var newJob = await _migrationService.ImportJobAsync(import);
                return Created($"/api/jobs/{newJob.Id}", newJob);
            }
            catch (ArgumentException ex)
            {
                return BadRequest(ex.Message);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = $"Gagal melakukan impor: {ex.Message}" });
            }
        }

        #endregion

        #region Migration Logs

        [HttpGet("/api/logs/{jobId:int}")]
        public async Task<IActionResult> GetMigrationLogs(int jobId)
        {
            try
            {
                var logs = await _migrationService.GetMigrationLogsAsync(jobId);
                return Ok(logs);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        #endregion

        #region DB Objects Scanning & Items

        [HttpGet("/api/jobs/{id:int}/obj-scan")]
        public async Task<IActionResult> ScanDbObjects(int id)
        {
            try
            {
                var objects = await _migrationService.ScanDbObjectsAsync(id);
                return Ok(objects);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpGet("/api/jobs/{id:int}/obj-items")]
        public async Task<IActionResult> GetObjItems(int id)
        {
            try
            {
                var items = await _migrationService.GetObjItemsAsync(id);
                return Ok(items);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("/api/jobs/{id:int}/obj-items/reorder")]
        public async Task<IActionResult> ReorderObjItems(int id, [FromBody] List<ReorderItemDto> items)
        {
            try
            {
                await _migrationService.ReorderObjItemsAsync(id, items);
                return Ok(new { Message = "Urutan migrasi objek berhasil diperbarui." });
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("/api/obj-items")]
        public async Task<IActionResult> SaveObjItem([FromBody] ObjectMigrationItem item)
        {
            try
            {
                var result = await _migrationService.SaveObjItemAsync(item);
                if (item.Id > 0)
                {
                    return Ok(result);
                }
                return Created($"/api/obj-items/{result.Id}", result);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("/api/jobs/{id:int}/obj-items/bulk")]
        public async Task<IActionResult> BulkAddObjItems(int id, [FromBody] List<ObjectMigrationItem> items)
        {
            try
            {
                await _migrationService.BulkAddObjItemsAsync(id, items);
                return Ok(new { Message = $"{items.Count} objek berhasil ditambahkan." });
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpDelete("/api/obj-items/{id:int}")]
        public async Task<IActionResult> DeleteObjItem(int id)
        {
            try
            {
                await _migrationService.DeleteObjItemAsync(id);
                return Ok();
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        #endregion

        #region DB Objects Definition & Backups

        [HttpGet("/api/obj-items/{id:int}/backups")]
        public async Task<IActionResult> GetObjBackups(int id)
        {
            try
            {
                var backups = await _migrationService.GetObjBackupsAsync(id);
                return Ok(backups);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpGet("/api/obj-backups/{id:int}/download")]
        public async Task<IActionResult> DownloadObjBackup(int id)
        {
            try
            {
                var backup = await _migrationService.GetObjBackupDownloadDataAsync(id);
                if (backup == null) return NotFound();

                string backupScript = backup.BackupScript;
                int version = backup.Version;
                DateTime backedUpAt = backup.BackedUpAt;
                string objectName = backup.ObjectName ?? "backup";

                string safeObjectName = objectName;
                foreach (char c in System.IO.Path.GetInvalidFileNameChars())
                {
                    safeObjectName = safeObjectName.Replace(c, '_');
                }
                safeObjectName = safeObjectName.Replace('.', '_');

                var bytes = System.Text.Encoding.UTF8.GetBytes(backupScript);
                return File(bytes, "application/sql", $"{safeObjectName}_v{version}_{backedUpAt:yyyyMMdd_HHmmss}.sql");
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpGet("/api/jobs/{jobId:int}/obj-items/{itemId:int}/definition")]
        public async Task<IActionResult> GetObjItemDefinition(int jobId, int itemId)
        {
            try
            {
                var def = await _migrationService.GetObjItemDefinitionAsync(jobId, itemId);
                return Ok(new
                {
                    Success = true,
                    ObjectName = def.ObjectName,
                    ObjectType = def.ObjectType,
                    SourceDdl = def.SourceDdl,
                    TargetDdl = def.TargetDdl
                });
            }
            catch (ArgumentException ex)
            {
                return NotFound(ex.Message);
            }
            catch (Exception ex)
            {
                return Problem(ex.Message);
            }
        }

        [HttpGet("/api/jobs/{id:int}/obj-logs")]
        public async Task<IActionResult> GetObjLogs(int id)
        {
            try
            {
                var logs = await _migrationService.GetObjLogsAsync(id);
                return Ok(logs);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        #endregion

        #region Run Object Migration

        [HttpPost("/api/jobs/{id:int}/obj-run")]
        public async Task<IActionResult> RunObjMigration(int id, [FromQuery] int? itemId)
        {
            try
            {
                var results = await _migrationService.RunObjMigrationAsync(id, itemId);
                return Ok(new { Message = "Migrasi objek selesai.", Results = results });
            }
            catch (ArgumentException ex)
            {
                return NotFound(ex.Message);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        #endregion

        #region Clean Target Tables

        [HttpGet("/api/jobs/{jobId:int}/clean-tables")]
        public async Task<IActionResult> GetCleanTables(int jobId)
        {
            try
            {
                var tables = await _migrationService.GetCleanTablesAsync(jobId);
                return Ok(tables);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("/api/jobs/{jobId:int}/clean-tables")]
        public async Task<IActionResult> AddCleanTables(int jobId, [FromBody] CleanTableRequest request)
        {
            try
            {
                var result = await _migrationService.AddCleanTablesAsync(jobId, request);
                return Ok(new
                {
                    Message = "Proses penambahan selesai.",
                    Added = result.Added,
                    Skipped = result.Skipped
                });
            }
            catch (ArgumentException ex)
            {
                return BadRequest(ex.Message);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpDelete("/api/clean-tables/{id:int}")]
        public async Task<IActionResult> DeleteCleanTable(int id)
        {
            try
            {
                await _migrationService.DeleteCleanTableAsync(id);
                return Ok();
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("/api/jobs/{jobId:int}/clean-tables/reorder")]
        public async Task<IActionResult> ReorderCleanTables(int jobId, [FromBody] List<ReorderItemDto> items)
        {
            try
            {
                await _migrationService.ReorderCleanTablesAsync(jobId, items);
                return Ok(new { Message = "Urutan tabel pembersih berhasil diperbarui." });
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("/api/jobs/{jobId:int}/clean-tables/run")]
        public async Task<IActionResult> RunCleanTables(int jobId, [FromQuery] int? id)
        {
            try
            {
                var results = await _migrationService.RunCleanTablesAsync(jobId, id);
                return Ok(new { Message = "Proses pembersihan selesai.", Results = results });
            }
            catch (ArgumentException ex)
            {
                return NotFound(ex.Message);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpGet("/api/jobs/{jobId:int}/clean-tables/generate-sp")]
        public async Task<IActionResult> GenerateCleanSp(int jobId)
        {
            try
            {
                var result = await _migrationService.GenerateCleanSpAsync(jobId);
                return Ok(new { SpName = result.SpName, SqlScript = result.SqlScript });
            }
            catch (ArgumentException ex)
            {
                return NotFound(ex.Message);
            }
            catch (Exception ex)
            {
                return BadRequest(ex.Message);
            }
        }

        #endregion

        #region Reset Status

        [HttpPost("/api/jobs/{jobId:int}/clean-tables/reset-status")]
        public async Task<IActionResult> ResetCleanTablesStatus(int jobId)
        {
            try
            {
                await _migrationService.ResetCleanTablesStatusAsync(jobId);
                return Ok(new { Message = "Status pembersihan berhasil direset ke Pending." });
            }
            catch (ArgumentException ex)
            {
                return NotFound(ex.Message);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("/api/jobs/{jobId:int}/mappings/reset-status")]
        public async Task<IActionResult> ResetDataMappingsStatus(int jobId)
        {
            try
            {
                await _migrationService.ResetDataMappingsStatusAsync(jobId);
                return Ok(new { Message = "Status pemetaan data berhasil direset ke Pending." });
            }
            catch (ArgumentException ex)
            {
                return NotFound(ex.Message);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("/api/jobs/{jobId:int}/obj-items/reset-status")]
        public async Task<IActionResult> ResetObjItemsStatus(int jobId)
        {
            try
            {
                await _migrationService.ResetObjItemsStatusAsync(jobId);
                return Ok(new { Message = "Status objek migrasi berhasil direset ke Pending." });
            }
            catch (ArgumentException ex)
            {
                return NotFound(ex.Message);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = ex.Message });
            }
        }

        #endregion
    }
}
