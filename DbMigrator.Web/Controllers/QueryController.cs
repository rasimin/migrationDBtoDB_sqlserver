using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Http;
using DbMigrator.Core;
using DbMigrator.Web.Models;
using DbMigrator.Web.Services;

namespace DbMigrator.Web.Controllers
{
    [ApiController]
    [Route("api/query")]
    public class QueryController : ControllerBase
    {
        private readonly QueryService _queryService;

        public QueryController(QueryService queryService)
        {
            _queryService = queryService;
        }

        [HttpGet("saved-queries")]
        public async Task<IActionResult> GetSavedQueries(
            [FromQuery] string searchTerm = null, 
            [FromQuery] DateTime? startDate = null, 
            [FromQuery] DateTime? endDate = null)
        {
            try
            {
                var queries = await _queryService.GetSavedQueriesAsync(searchTerm, startDate, endDate);
                return Ok(queries);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = $"Gagal mengambil daftar query: {ex.Message}" });
            }
        }

        [HttpGet("saved-queries/{id:int}")]
        public async Task<IActionResult> GetSavedQueryById(int id)
        {
            try
            {
                var query = await _queryService.GetSavedQueryByIdAsync(id);
                if (query == null)
                {
                    return NotFound(new { Success = false, Message = $"Query dengan ID {id} tidak ditemukan" });
                }
                return Ok(query);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = $"Gagal mengambil detail query: {ex.Message}" });
            }
        }

        [HttpPost("saved-queries")]
        public async Task<IActionResult> SaveSavedQuery([FromBody] SavedQuery request)
        {
            if (string.IsNullOrEmpty(request?.QueryName) || string.IsNullOrEmpty(request?.QueryText))
            {
                return BadRequest(new { Success = false, Message = "Nama Query dan Script Query tidak boleh kosong" });
            }

            try
            {
                var id = await _queryService.SaveSavedQueryAsync(request);
                return Ok(new { Success = true, Message = "Query berhasil disimpan", Id = id });
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = $"Gagal menyimpan query: {ex.Message}" });
            }
        }

        [HttpGet("saved-queries/{id:int}/history")]
        public async Task<IActionResult> GetQueryHistory(int id)
        {
            try
            {
                var history = await _queryService.GetQueryHistoryAsync(id);
                return Ok(history);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = $"Gagal mengambil riwayat versi: {ex.Message}" });
            }
        }

        [HttpPost("saved-queries/{id:int}/delete")]
        [HttpDelete("saved-queries/{id:int}")]
        public async Task<IActionResult> DeleteSavedQuery(int id)
        {
            try
            {
                var deleted = await _queryService.DeleteSavedQueryAsync(id);
                if (deleted)
                {
                    return Ok(new { Success = true, Message = "Query berhasil dihapus" });
                }
                return NotFound(new { Success = false, Message = "Query tidak ditemukan" });
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = $"Gagal menghapus query: {ex.Message}" });
            }
        }

        [HttpGet("connections")]
        public async Task<IActionResult> GetSavedConnections()
        {
            try
            {
                var connections = await _queryService.GetSavedConnectionsAsync();
                return Ok(connections);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = $"Gagal mengambil daftar koneksi: {ex.Message}" });
            }
        }

        [HttpPost("connections")]
        public async Task<IActionResult> SaveSavedConnection([FromBody] SavedConnection request)
        {
            if (string.IsNullOrEmpty(request?.ConnectionName) || string.IsNullOrEmpty(request?.ServerName))
            {
                return BadRequest(new { Success = false, Message = "Nama Koneksi dan Server Name tidak boleh kosong" });
            }

            try
            {
                var id = await _queryService.SaveSavedConnectionAsync(request);
                return Ok(new { Success = true, Message = "Koneksi berhasil disimpan/diperbarui", Id = id });
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = $"Gagal menyimpan koneksi: {ex.Message}" });
            }
        }

        [HttpPost("connections/{id:int}/delete")]
        [HttpDelete("connections/{id:int}")]
        public async Task<IActionResult> DeleteSavedConnection(int id)
        {
            try
            {
                var deleted = await _queryService.DeleteSavedConnectionAsync(id);
                if (deleted)
                {
                    return Ok(new { Success = true, Message = "Koneksi berhasil dihapus" });
                }
                return NotFound(new { Success = false, Message = "Koneksi tidak ditemukan" });
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = $"Gagal menghapus koneksi: {ex.Message}" });
            }
        }

        [HttpPost("connect")]
        public async Task<IActionResult> Connect([FromBody] QueryConnectRequest request)
        {
            if (string.IsNullOrEmpty(request?.ServerName))
            {
                return BadRequest(new { Success = false, Message = "Server name tidak boleh kosong" });
            }

            try
            {
                var databases = await _queryService.ConnectAsync(request);
                return Ok(new { Success = true, Databases = databases, DefaultDatabase = "master" });
            }
            catch (Exception ex)
            {
                return Ok(new { Success = false, Message = $"Gagal terhubung ke server: {ex.Message}" });
            }
        }

        [HttpPost("schema")]
        public async Task<IActionResult> GetSchema([FromBody] QuerySchemaRequest request)
        {
            if (string.IsNullOrEmpty(request?.ServerName) || string.IsNullOrEmpty(request?.Database))
            {
                return BadRequest("ServerName dan Database tidak boleh kosong");
            }

            try
            {
                var schema = await _queryService.GetSchemaAsync(request);
                return Ok(new { Objects = schema.Objects, Columns = schema.Columns });
            }
            catch (Exception ex)
            {
                return BadRequest($"Gagal mengambil skema database: {ex.Message}");
            }
        }

        [HttpPost("execute")]
        public async Task<IActionResult> ExecuteQuery([FromBody] QueryExecuteRequest request, CancellationToken cancellationToken)
        {
            if (string.IsNullOrEmpty(request?.ServerName) || string.IsNullOrEmpty(request?.Database) || string.IsNullOrEmpty(request?.QueryText))
            {
                return BadRequest(new { Success = false, Message = "ServerName, Database, dan QueryText tidak boleh kosong" });
            }

            try
            {
                var result = await _queryService.ExecuteQueryAsync(request, cancellationToken);
                return Ok(new { 
                    Success = true, 
                    Tables = result.Tables,
                    Headers = result.Headers, 
                    Rows = result.Rows, 
                    ExecutionTimeMs = result.ExecutionTimeMs,
                    PrintMessages = result.PrintMessages
                });
            }
            catch (OperationCanceledException)
            {
                return StatusCode(499);
            }
            catch (Exception ex)
            {
                return Ok(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("schema-objects")]
        public async Task<IActionResult> GetSchemaObjects([FromBody] QuerySchemaObjectsRequest request)
        {
            if (string.IsNullOrEmpty(request?.ServerName) || string.IsNullOrEmpty(request?.Database))
            {
                return BadRequest(new { Success = false, Message = "ServerName dan Database tidak boleh kosong" });
            }

            try
            {
                var objects = await _queryService.GetSchemaObjectsAsync(request);
                return Ok(new { Success = true, Objects = objects });
            }
            catch (Exception ex)
            {
                return Ok(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("schema-definition")]
        public async Task<IActionResult> GetSchemaDefinition([FromBody] QuerySchemaDefinitionRequest request)
        {
            if (string.IsNullOrEmpty(request?.ServerName) || string.IsNullOrEmpty(request?.Database) || string.IsNullOrEmpty(request?.ObjectName))
            {
                return BadRequest(new { Success = false, Message = "ServerName, Database, dan ObjectName tidak boleh kosong" });
            }

            try
            {
                var ddl = await _queryService.GetSchemaDefinitionAsync(request);
                return Ok(new { Success = true, Ddl = ddl });
            }
            catch (Exception ex)
            {
                return Ok(new { Success = false, Message = ex.Message });
            }
        }

        [HttpPost("generate-inserts")]
        public async Task<IActionResult> GenerateInserts([FromBody] QueryGenerateInsertsRequest request)
        {
            if (string.IsNullOrEmpty(request?.ServerName) || string.IsNullOrEmpty(request?.Database) || string.IsNullOrEmpty(request?.TableName))
            {
                return BadRequest(new { Success = false, Message = "ServerName, Database, dan TableName tidak boleh kosong" });
            }

            try
            {
                var result = await _queryService.GenerateInsertsAsync(request);
                return Ok(new { Success = true, Script = result.Script, RowCount = result.RowCount });
            }
            catch (Exception ex)
            {
                return Ok(new { Success = false, Message = $"Gagal generate insert script: {ex.Message}" });
            }
        }

        [HttpGet("execution-logs")]
        public async Task<IActionResult> GetExecutionLogs([FromQuery] string databaseName = null, [FromQuery] string searchTerm = null)
        {
            try
            {
                var logs = await _queryService.GetExecutionLogsAsync(databaseName, searchTerm);
                return Ok(logs);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = $"Gagal mengambil log: {ex.Message}" });
            }
        }
    }
}
