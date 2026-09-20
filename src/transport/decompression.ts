import { tokenPriceError } from "../domain/errors";

export const MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB maximum uncompressed size

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

      const reader = ds.readable.getReader();
      const chunks: Uint8Array[] = [];
      let totalLength = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalLength += value.byteLength;
        if (totalLength > MAX_DECOMPRESSED_BYTES) {
          throw tokenPriceError("INVALID_PROVIDER_RESPONSE", "Decompressed archive exceeds maximum allowed size.");
        }
        chunks.push(value);
      }
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    } catch (error: any) {
      if (error?.code === "INVALID_PROVIDER_RESPONSE") throw error;
      // Continue to node:zlib fallback
    }
  }

  // Node.js fallback via dynamic import of node:zlib
  try {
    const zlib = await import("node:zlib");
    return new Promise<Uint8Array>((resolve, reject) => {
      zlib.gunzip(bytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES }, (err, result) => {
        if (err) reject(tokenPriceError("PROVIDER_UNAVAILABLE", "Failed to gunzip archive.", { cause: err }));
        else resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
      });
    });
  } catch (error: any) {
    if (error?.code === "INVALID_PROVIDER_RESPONSE") throw error;
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

  if (uncompressedSize > MAX_DECOMPRESSED_BYTES) {
    throw tokenPriceError("INVALID_PROVIDER_RESPONSE", "ZIP entry uncompressed size exceeds maximum allowed limit.");
  }

  const dataOffset = 30 + fileNameLen + extraFieldLen;
  if (dataOffset > bytes.length) {
    throw tokenPriceError("PROVIDER_UNAVAILABLE", "ZIP archive corrupt: data offset beyond buffer length.");
  }

  // If compression method is 0 (stored uncompressed)
  if (compressionMethod === 0) {
    const end = compressedSize > 0 ? dataOffset + compressedSize : dataOffset + uncompressedSize;
    if (end - dataOffset > MAX_DECOMPRESSED_BYTES) {
      throw tokenPriceError("INVALID_PROVIDER_RESPONSE", "Uncompressed ZIP entry exceeds maximum allowed size.");
    }
    return bytes.subarray(dataOffset, end);
  }

  // If compression method is 8 (Deflate)
  if (compressionMethod === 8) {
    let compressedData: Uint8Array;
    if (compressedSize > 0) {
      compressedData = bytes.subarray(dataOffset, dataOffset + compressedSize);
    } else {
      // Search backward for End of Central Directory signature: 0x06054b50
      let cdOffset = -1;
      for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
          cdOffset = view.getUint32(i + 16, true);
          break;
        }
      }

      if (cdOffset >= dataOffset && cdOffset <= bytes.length) {
        compressedData = bytes.subarray(dataOffset, cdOffset);
      } else {
        // Fallback: search backwards for central directory header 0x02014b50
        let centralIdx = -1;
        for (let i = bytes.length - 4; i >= dataOffset; i--) {
          if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x01 && bytes[i + 3] === 0x02) {
            centralIdx = i;
            break;
          }
        }
        compressedData = centralIdx !== -1 ? bytes.subarray(dataOffset, centralIdx) : bytes.subarray(dataOffset);
      }
    }

    if (typeof DecompressionStream !== "undefined") {
      try {
        const ds = new DecompressionStream("deflate-raw");
        const writer = ds.writable.getWriter();
        writer.write(compressedData as any);
        writer.close();

        const reader = ds.readable.getReader();
        const chunks: Uint8Array[] = [];
        let totalLength = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalLength += value.byteLength;
          if (totalLength > MAX_DECOMPRESSED_BYTES) {
            throw tokenPriceError("INVALID_PROVIDER_RESPONSE", "Decompressed ZIP entry exceeds maximum allowed size.");
          }
          chunks.push(value);
        }
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return result;
      } catch (error: any) {
        if (error?.code === "INVALID_PROVIDER_RESPONSE") throw error;
        // Continue to node:zlib fallback
      }
    }

    // Node.js fallback via dynamic import of node:zlib
    try {
      const zlib = await import("node:zlib");
      return new Promise<Uint8Array>((resolve, reject) => {
        zlib.inflateRaw(compressedData, { maxOutputLength: MAX_DECOMPRESSED_BYTES }, (err, result) => {
          if (err) reject(tokenPriceError("PROVIDER_UNAVAILABLE", "Failed to inflate raw zip entry.", { cause: err }));
          else resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
        });
      });
    } catch (error: any) {
      if (error?.code === "INVALID_PROVIDER_RESPONSE") throw error;
      throw tokenPriceError("UNSUPPORTED_OPERATION", "Deflate decompression is not supported in this environment.", { cause: error });
    }
  }

  throw tokenPriceError("UNSUPPORTED_OPERATION", `Unsupported ZIP compression method: ${compressionMethod}`);
}
