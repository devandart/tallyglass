// SPDX-License-Identifier: GPL-3.0-or-later
// Parses transcript files off the main thread. One message in per file, one result out.
import { createFileParser } from './parse.js?v=6';

const CHUNK = 4 << 20;

self.onmessage = async (e) => {
  const { id, file, cls } = e.data;
  try {
    const parser = createFileParser(cls);
    const decoder = new TextDecoder();
    let done = 0;
    // Slicing the Blob keeps memory flat even for multi-GB transcripts.
    for (let off = 0; off < file.size; off += CHUNK) {
      const buf = await file.slice(off, off + CHUNK).arrayBuffer();
      parser.push(decoder.decode(buf, { stream: off + CHUNK < file.size }));
      done = Math.min(file.size, off + CHUNK);
      self.postMessage({ id, progress: done });
    }
    self.postMessage({ id, result: parser.finish() });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
