import { tokenPriceError } from "../domain/errors";

/**
 * Decompresses Gzip data (used by Gate.io monthly archive csv.gz files).
 * Works isomorphically in Node.js 18+ and modern browsers using native DecompressionStream.
 */
export async function decompressGzip(data: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (typeof DecompressionStream !== "undefined") {
    try {
      const ds = new DecompressionStream("gzip");
      const writer = ds.writable.getWriter();
      writer.write(bytes as any);
      writer.close();
      const response = new Response(ds.readable);
      const arrayBuffer = await response.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    } catch {
      // Continue to node:zlib fallback
    }
  }

  // Node.js fallback via dynamic import of node:zlib
  try {
    const zlib = await import("node:zlib");
    return new Promise<Uint8Array>((resolve, reject) => {
      zlib.gunzip(bytes, (err, result) => {
        if (err) reject(tokenPriceError("PROVIDER_UNAVAILABLE", "Failed to gunzip archive.", { cause: err }));
        else resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
      });
    });
  } catch (error) {
    throw tokenPriceError("UNSUPPORTED_OPERATION", "Gzip decompression is not supported in this environment.", { cause: error });
  }
}

/**
 * Extracts and decompresses the first file from a PKZip archive (used by Binance monthly archive .zip files).
 * Binance monthly klines zip files contain a single CSV file compressed via Deflate or stored uncompressed.
 */
export async function decompressZipSingleFile(data: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Check PKZip signature: 0x04034b50 (little-endian: 0x50, 0x4b, 0x03, 0x04)
  if (bytes.length < 30 || view.getUint32(0, true) !== 0x04034b50) {
    throw tokenPriceError("PROVIDER_UNAVAILABLE", "Invalid ZIP archive header signature.");
  }

  const compressionMethod = view.getUint16(8, true);
  let compressedSize = view.getUint32(18, true);
  const uncompressedSize = view.getUint32(22, true);
  const fileNameLen = view.getUint16(26, true);
  const extraFieldLen = view.getUint16(28, true);

  const dataOffset = 30 + fileNameLen + extraFieldLen;
  if (dataOffset > bytes.length) {
    throw tokenPriceError("PROVIDER_UNAVAILABLE", "ZIP archive corrupt: data offset beyond buffer length.");
  }

  // If compression method is 0 (stored uncompressed)
  if (compressionMethod === 0) {
    const end = compressedSize > 0 ? dataOffset + compressedSize : dataOffset + uncompressedSize;
    return bytes.subarray(dataOffset, end);
  }

  // If compression method is 8 (Deflate)
  if (compressionMethod === 8) {
    let compressedData: Uint8Array;
    if (compressedSize > 0) {
      compressedData = bytes.subarray(dataOffset, dataOffset + compressedSize);
    } else {
      // If compressed size is 0 in local header, extract until central directory signature 0x02014b50
      let centralIdx = -1;
      for (let i = dataOffset; i < bytes.length - 4; i++) {
        if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x01 && bytes[i + 3] === 0x02) {
          centralIdx = i;
          break;
        }
      }
      compressedData = centralIdx !== -1 ? bytes.subarray(dataOffset, centralIdx) : bytes.subarray(dataOffset);
    }

    if (typeof DecompressionStream !== "undefined") {
      try {
        const ds = new DecompressionStream("deflate-raw");
        const writer = ds.writable.getWriter();
        writer.write(compressedData as any);
        writer.close();
        const response = new Response(ds.readable);
        const arrayBuffer = await response.arrayBuffer();
        return new Uint8Array(arrayBuffer);
      } catch (error) {
        // Continue to node:zlib fallback
      }
    }

    // Node.js fallback via dynamic import of node:zlib
    try {
      const zlib = await import("node:zlib");
      return new Promise<Uint8Array>((resolve, reject) => {
        zlib.inflateRaw(compressedData, (err, result) => {
          if (err) reject(tokenPriceError("PROVIDER_UNAVAILABLE", "Failed to inflate raw zip entry.", { cause: err }));
          else resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
        });
      });
    } catch (error) {
      throw tokenPriceError("UNSUPPORTED_OPERATION", "Deflate decompression is not supported in this environment.", { cause: error });
    }
  }

  throw tokenPriceError("UNSUPPORTED_OPERATION", `Unsupported ZIP compression method: ${compressionMethod}`);
}
