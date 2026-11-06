import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {boundedFetch, openBank} from '../online/core.mjs';

const originalFetch = globalThis.fetch;
const base = new URL('../original/bank-civil-aptitude/', import.meta.url);
const networkBase = new URL('https://reader.test/bank/');
const entryBytes = await readFile(new URL('bank.json', base));
const entry = JSON.parse(entryBytes);
const manifest = JSON.parse(await readFile(new URL(entry.currentRelease.manifestPath, base)));
const asset = manifest.media.find(m => m.mediaId === 'media_ca3a685217319656164b3f1e32116974cf455d8a393875a924dc7ed0ca11c2b7');
assert.equal(asset.byteLength, 810);
const assetRelative = `releases/${manifest.releaseId}/${asset.path}`;
const assetBytes = await readFile(new URL(assetRelative, base));
const occurrence = {status:'ready', mediaId:asset.mediaId};

async function withFetch(mock, operation) {
  globalThis.fetch = mock;
  try { return await operation(); }
  finally { globalThis.fetch = originalFetch; }
}

function response(bytes, headers = {}) {
  // fetch exposes an already-decoded body, even if Content-Length describes gzip/br.
  return new Response(bytes, {headers});
}

async function localResponse(url, options, mutation) {
  const target = new URL(url);
  assert.equal(target.origin, networkBase.origin);
  assert.ok(target.pathname.startsWith(networkBase.pathname));
  assert.equal(options.redirect, 'error');
  const relative = target.pathname.slice(networkBase.pathname.length);
  let bytes = new Uint8Array(await readFile(new URL(relative, base)));
  if (mutation) bytes = mutation(relative, bytes);
  const headers = {'Content-Length':String(bytes.length)};
  if (relative === assetRelative) {
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = '833';
  }
  return response(bytes, headers);
}

test('gzip, br and mixed encoded transfer lengths do not reject valid decoded bytes', async () => {
  for (const encoding of ['gzip','br','gzip, br',' GZip ']) {
    await withFetch(async () => response(assetBytes, {'Content-Encoding':encoding,'Content-Length':'833'}), async () => {
      assert.deepEqual(await boundedFetch(new URL('https://reader.test/image'),810), new Uint8Array(assetBytes));
    });
  }
});

test('identity or missing Content-Encoding still rejects an oversized declared length', async () => {
  for (const encoding of [undefined,'identity','']) {
    const headers = {'Content-Length':'811'};
    if (encoding !== undefined) headers['Content-Encoding'] = encoding;
    await withFetch(async () => response(assetBytes,headers), async () => {
      await assert.rejects(boundedFetch(new URL('https://reader.test/image'),810), /response_budget/);
    });
  }
});

test('decompressed streaming budget still rejects oversized data regardless of headers', async () => {
  for (const headers of [{},{'Content-Encoding':'gzip','Content-Length':'20'},{'Content-Encoding':'br','Content-Length':'999'}]) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(800)); controller.enqueue(new Uint8Array(11)); },
      cancel() { cancelled = true; }
    });
    await withFetch(async () => new Response(body,{headers}), async () => {
      await assert.rejects(boundedFetch(new URL('https://reader.test/image'),810), /response_budget/);
      assert.equal(cancelled,true);
    });
  }
});

test('HTTP failures and caller cancellation are preserved', async () => {
  await withFetch(async () => new Response('',{status:404}), async () => {
    await assert.rejects(boundedFetch(new URL('https://reader.test/image'),810), /network_http_404/);
  });
  const abort = new AbortController(); abort.abort();
  await withFetch(async (_url,options) => { assert.equal(options.signal.aborted,true); throw new DOMException('aborted','AbortError'); }, async () => {
    await assert.rejects(boundedFetch(new URL('https://reader.test/image'),810,abort.signal), {name:'AbortError'});
  });
});

test('unmodified signed package opens and gzip image verifies at its original 810-byte hash', async () => {
  await withFetch((u,o) => localResponse(u,o), async () => {
    const bank = await openBank(networkBase);
    assert.equal(bank.manifest.questionCount,70575);
    const blob = await bank.image(occurrence);
    assert.equal(blob.type,'image/png');
    assert.equal(blob.size,810);
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),new Uint8Array(assetBytes));
  });
});

test('same-length tampered image still fails SHA256 verification', async () => {
  await withFetch((u,o) => localResponse(u,o,(relative,bytes) => {
    if (relative === assetRelative) { bytes = bytes.slice(); bytes[0] ^= 1; }
    return bytes;
  }), async () => {
    const bank = await openBank(networkBase);
    await assert.rejects(bank.image(occurrence), /file_hash_mismatch/);
  });
});

test('short image still fails exact signed length verification', async () => {
  await withFetch((u,o) => localResponse(u,o,(relative,bytes) => relative === assetRelative ? bytes.slice(0,-1) : bytes), async () => {
    const bank = await openBank(networkBase);
    await assert.rejects(bank.image(occurrence), /file_hash_mismatch/);
  });
});

test('a modified signed entry is rejected', async () => {
  await withFetch((u,o) => localResponse(u,o,(relative,bytes) => {
    if (relative === 'bank.json') {
      const text = new TextDecoder().decode(bytes);
      return new TextEncoder().encode(text.replace('bank-civil-aptitude','bank-civil-aptitudf'));
    }
    return bytes;
  }), async () => {
    await assert.rejects(openBank(networkBase), /signature_invalid/);
  });
});

test('signed reader core and portal retain original verification with approved transport and routing changes', async () => {
  const sourceCore = await readFile(new URL('../original/bank-civil-aptitude/site/core.mjs',import.meta.url),'utf8');
  const copiedCore = await readFile(new URL('../online/core.mjs',import.meta.url),'utf8');
  const normalized = copiedCore.replace('// Encoded Content-Length measures transfer bytes, but fetch streams decoded bytes.\n// Keep the streamed decoded-byte budget and signed length/SHA checks unchanged.\n','').replace("const encoding=(r.headers.get('Content-Encoding')||'identity').trim().toLowerCase();if((!encoding||encoding==='identity')&&Number(r.headers.get('Content-Length'))>max)","if(Number(r.headers.get('Content-Length'))>max)");
  assert.equal(normalized,sourceCore);
  for (const [name,from,to] of [
    ['portal.mjs',"openBank(new URL('../original/bank-civil-aptitude/',import.meta.url))","openBank(new URL('../',import.meta.url))"]
  ]) {
    const actual = await readFile(new URL(`../online/${name}`,import.meta.url),'utf8');
    const original = await readFile(new URL(`../original/bank-civil-aptitude/site/${name}`,import.meta.url),'utf8');
    assert.equal(actual.replace(from,to),original);
  }
});
