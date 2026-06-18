using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using DbMigrator.Core;
using DbMigrator.Web.Services;

namespace DbMigrator.Web.Controllers
{
    [ApiController]
    [Route("api/whiteboards")]
    public class WhiteboardController : ControllerBase
    {
        private readonly WhiteboardService _whiteboardService;

        public WhiteboardController(WhiteboardService whiteboardService)
        {
            _whiteboardService = whiteboardService;
        }

        [HttpGet]
        public async Task<IActionResult> GetWhiteboards()
        {
            try
            {
                var whiteboards = await _whiteboardService.GetWhiteboardsAsync();
                return Ok(whiteboards);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = $"Gagal mengambil daftar sketsa: {ex.Message}" });
            }
        }

        [HttpGet("{id:int}")]
        public async Task<IActionResult> GetWhiteboardById(int id)
        {
            try
            {
                var wb = await _whiteboardService.GetWhiteboardByIdAsync(id);
                if (wb == null)
                {
                    return NotFound(new { Success = false, Message = $"Sketsa dengan ID {id} tidak ditemukan" });
                }
                return Ok(wb);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = $"Gagal mengambil sketsa: {ex.Message}" });
            }
        }

        [HttpPost]
        public async Task<IActionResult> CreateWhiteboard([FromBody] JobWhiteboard request)
        {
            try
            {
                var id = await _whiteboardService.CreateWhiteboardAsync(request);
                request.Id = id;
                return Created($"/api/whiteboards/{id}", request);
            }
            catch (ArgumentException ex)
            {
                return BadRequest(ex.Message);
            }
            catch (InvalidOperationException ex)
            {
                return BadRequest(ex.Message);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = $"Gagal membuat sketsa: {ex.Message}" });
            }
        }

        [HttpPut("{id:int}")]
        public async Task<IActionResult> SaveWhiteboard(int id, [FromBody] JobWhiteboard request)
        {
            try
            {
                var success = await _whiteboardService.SaveWhiteboardAsync(id, request);
                if (!success)
                {
                    return NotFound(new { Success = false, Message = $"Sketsa dengan ID {id} tidak ditemukan" });
                }
                return Ok();
            }
            catch (ArgumentNullException ex)
            {
                return BadRequest(ex.Message);
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = $"Gagal menyimpan sketsa: {ex.Message}" });
            }
        }

        [HttpDelete("{id:int}")]
        public async Task<IActionResult> DeleteWhiteboard(int id)
        {
            try
            {
                var success = await _whiteboardService.DeleteWhiteboardAsync(id);
                if (!success)
                {
                    return NotFound(new { Success = false, Message = $"Sketsa dengan ID {id} tidak ditemukan" });
                }
                return Ok();
            }
            catch (Exception ex)
            {
                return BadRequest(new { Success = false, Message = $"Gagal menghapus sketsa: {ex.Message}" });
            }
        }
    }
}
