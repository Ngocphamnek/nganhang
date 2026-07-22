/**
 * Worker thread chạy Go WASM trong môi trường riêng biệt.
 * Main thread gửi payload JSON → worker trả về dataEnc string.
 */
import { workerData, parentPort } from "worker_threads";
import { request } from "undici";

const WASM_URL = "https://online.mbbank.com.vn/assets/wasm/main.wasm";

// ── Polyfills ──────────────────────────────────────────────────────────────
const dec = new TextDecoder("utf-8");
let fsBuf = "";
(globalThis as any).fs = {
  constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1 },
  writeSync(_fd: number, data: Uint8Array) {
    fsBuf += dec.decode(data);
    const nl = fsBuf.lastIndexOf("\n");
    if (nl !== -1) fsBuf = fsBuf.substring(nl + 1);
    return data.length;
  },
  write(_fd: number, data: Uint8Array, o: number, l: number, p: null, cb: Function) {
    cb(null, this.writeSync(_fd, data));
  },
  fsync(_fd: number, cb: Function) { cb(null); },
};
(globalThis as any).window = { globalThis, document: { welovemb: true } };
(globalThis as any).location = new URL("https://online.mbbank.com.vn/pl/login");

// ── Go runtime minimal (gojs) ─────────────────────────────────────────────
const textEnc = new TextEncoder();
const textDec = new TextDecoder("utf-8");
let inst: WebAssembly.Instance;
let memView: DataView;
let _values: unknown[];
let _goRefCounts: number[];
let _ids: Map<unknown, number>;
let _idPool: number[];
let _pendingEvent: any = null;
const _scheduledTimeouts = new Map<number, ReturnType<typeof setTimeout>>();
let _nextTimeout = 1;
let _exited = false;
let _exitResolve: () => void;
const _exitPromise = new Promise<void>((r) => (_exitResolve = r));

const mem = () => memView;
function getInt64(addr: number) {
  const lo = mem().getUint32(addr, true);
  const hi = mem().getInt32(addr + 4, true);
  return lo + hi * 4294967296;
}
function setInt64(addr: number, v: number) {
  mem().setUint32(addr + 0, v, true);
  mem().setUint32(addr + 4, Math.floor(v / 4294967296), true);
}
function loadValue(addr: number): unknown {
  const f = mem().getFloat64(addr, true);
  if (f === 0) return undefined;
  if (!isNaN(f)) return f;
  const id = mem().getUint32(addr, true);
  return _values[id];
}
function storeValue(addr: number, v: unknown) {
  const nanHead = 0x7ff80000;
  if (typeof v === "number" && v !== 0) {
    if (isNaN(v)) { mem().setUint32(addr + 4, nanHead, true); mem().setUint32(addr, 0, true); return; }
    mem().setFloat64(addr, v, true); return;
  }
  if (v === undefined) { mem().setFloat64(addr, 0, true); return; }
  let id = _ids.get(v);
  if (id === undefined) {
    id = _idPool.pop();
    if (id === undefined) { id = _values.length; _values.push(v); _goRefCounts.push(0); }
    else { _values[id] = v; _goRefCounts[id] = 0; }
    _ids.set(v, id);
  }
  _goRefCounts[id]++;
  let tf = 0;
  switch (typeof v) {
    case "object": if (v !== null) tf = 1; break;
    case "string": tf = 2; break;
    case "symbol": tf = 3; break;
    case "function": tf = 4; break;
  }
  mem().setUint32(addr + 4, nanHead | tf, true);
  mem().setUint32(addr, id, true);
}
function loadSlice(addr: number) {
  const arr = getInt64(addr), len = getInt64(addr + 8);
  return new Uint8Array((inst.exports.mem as WebAssembly.Memory).buffer, arr, len);
}
function loadSliceOfValues(addr: number): unknown[] {
  const arr = getInt64(addr), len = getInt64(addr + 8);
  const a: unknown[] = new Array(len);
  for (let i = 0; i < len; i++) a[i] = loadValue(arr + i * 8);
  return a;
}
function loadString(addr: number) {
  const sa = getInt64(addr), len = getInt64(addr + 8);
  return textDec.decode(new DataView((inst.exports.mem as WebAssembly.Memory).buffer, sa, len));
}
function resume() {
  if (_exited) return;
  (inst.exports.resume as () => void)();
  if (_exited) _exitResolve();
}
const goRuntime = {
  _makeFuncWrapper(id: number) {
    return function (this: unknown, ...args: unknown[]) {
      const event: any = { id, this: this, args };
      _pendingEvent = event;
      resume();
      return event.result;
    };
  },
};

const importObject: WebAssembly.Imports = {
  gojs: {
    "runtime.wasmExit": (sp: number) => { sp >>>= 0; _exited = true; _exitResolve(); },
    "runtime.wasmWrite": (sp: number) => {
      sp >>>= 0;
      const fd = getInt64(sp + 8), p = getInt64(sp + 16), n = mem().getInt32(sp + 24, true);
      (globalThis as any).fs.writeSync(fd, new Uint8Array((inst.exports.mem as WebAssembly.Memory).buffer, p, n));
    },
    "runtime.resetMemoryDataView": (sp: number) => {
      sp >>>= 0;
      memView = new DataView((inst.exports.mem as WebAssembly.Memory).buffer);
    },
    "runtime.nanotime1": (sp: number) => { sp >>>= 0; setInt64(sp + 8, Date.now() * 1e6); },
    "runtime.walltime": (sp: number) => {
      sp >>>= 0;
      const t = Date.now();
      setInt64(sp + 8, Math.floor(t / 1000));
      mem().setInt32(sp + 16, (t % 1000) * 1e6, true);
    },
    "runtime.scheduleTimeoutEvent": (sp: number) => {
      sp >>>= 0;
      const id = _nextTimeout++;
      _scheduledTimeouts.set(id, setTimeout(resume, getInt64(sp + 8)));
      setInt64(sp + 16, id);
    },
    "runtime.clearTimeoutEvent": (sp: number) => {
      sp >>>= 0;
      clearTimeout(_scheduledTimeouts.get(getInt64(sp + 8)));
    },
    "runtime.getRandomData": (sp: number) => {
      sp >>>= 0;
      crypto.getRandomValues(loadSlice(sp + 8));
    },
    "syscall/js.finalizeRef": (sp: number) => {
      sp >>>= 0;
      const id = mem().getUint32(sp + 8, true);
      _goRefCounts[id]--;
      if (_goRefCounts[id] === 0) { const v = _values[id]; _ids.delete(v); _values[id] = null; _idPool.push(id); }
    },
    "syscall/js.stringVal": (sp: number) => { sp >>>= 0; storeValue(sp + 24, loadString(sp + 8)); },
    "syscall/js.valueGet": (sp: number) => {
      sp >>>= 0;
      const v = loadValue(sp + 8), k = loadString(sp + 16);
      const r = Reflect.get(v as any, k);
      sp = (inst.exports.getsp as () => number)() >>> 0;
      storeValue(sp + 32, r);
    },
    "syscall/js.valueSet": (sp: number) => {
      sp >>>= 0;
      Reflect.set(loadValue(sp + 8) as any, loadString(sp + 16), loadValue(sp + 24));
    },
    "syscall/js.valueDelete": (sp: number) => {
      sp >>>= 0;
      Reflect.deleteProperty(loadValue(sp + 8) as any, loadString(sp + 16));
    },
    "syscall/js.valueIndex": (sp: number) => {
      sp >>>= 0;
      storeValue(sp + 24, Reflect.get(loadValue(sp + 8) as any, getInt64(sp + 16)));
    },
    "syscall/js.valueSetIndex": (sp: number) => {
      sp >>>= 0;
      Reflect.set(loadValue(sp + 8) as any, getInt64(sp + 16), loadValue(sp + 24));
    },
    "syscall/js.valueCall": (sp: number) => {
      sp >>>= 0;
      try {
        const v = loadValue(sp + 8) as any, m = loadString(sp + 16), args = loadSliceOfValues(sp + 32);
        const r = Reflect.apply(Reflect.get(v, m), v, args);
        sp = (inst.exports.getsp as () => number)() >>> 0;
        storeValue(sp + 56, r);
        mem().setUint8(sp + 64, 1);
      } catch (e) {
        sp = (inst.exports.getsp as () => number)() >>> 0;
        storeValue(sp + 56, e);
        mem().setUint8(sp + 64, 0);
      }
    },
    "syscall/js.valueInvoke": (sp: number) => {
      sp >>>= 0;
      try {
        const v = loadValue(sp + 8) as Function, args = loadSliceOfValues(sp + 16);
        const r = Reflect.apply(v, undefined, args);
        sp = (inst.exports.getsp as () => number)() >>> 0;
        storeValue(sp + 40, r);
        mem().setUint8(sp + 48, 1);
      } catch (e) {
        sp = (inst.exports.getsp as () => number)() >>> 0;
        storeValue(sp + 40, e);
        mem().setUint8(sp + 48, 0);
      }
    },
    "syscall/js.valueNew": (sp: number) => {
      sp >>>= 0;
      try {
        const v = loadValue(sp + 8) as Function, args = loadSliceOfValues(sp + 16);
        const r = Reflect.construct(v, args);
        sp = (inst.exports.getsp as () => number)() >>> 0;
        storeValue(sp + 40, r);
        mem().setUint8(sp + 48, 1);
      } catch (e) {
        sp = (inst.exports.getsp as () => number)() >>> 0;
        storeValue(sp + 40, e);
        mem().setUint8(sp + 48, 0);
      }
    },
    "syscall/js.valueLength": (sp: number) => {
      sp >>>= 0;
      setInt64(sp + 16, (loadValue(sp + 8) as any).length);
    },
    "syscall/js.valuePrepareString": (sp: number) => {
      sp >>>= 0;
      const s = String(loadValue(sp + 8));
      const enc = textEnc.encode(s);
      storeValue(sp + 16, enc);
      setInt64(sp + 24, enc.length);
    },
    "syscall/js.valueLoadString": (sp: number) => {
      sp >>>= 0;
      loadSlice(sp + 16).set(loadValue(sp + 8) as Uint8Array);
    },
    "syscall/js.valueInstanceOf": (sp: number) => {
      sp >>>= 0;
      mem().setUint8(sp + 24, (loadValue(sp + 8) instanceof (loadValue(sp + 16) as Function)) ? 1 : 0);
    },
    "syscall/js.copyBytesToGo": (sp: number) => {
      sp >>>= 0;
      const dst = loadSlice(sp + 8), src = loadValue(sp + 32) as Uint8Array;
      if (!(src instanceof Uint8Array || src instanceof Uint8ClampedArray)) { mem().setUint8(sp + 48, 0); return; }
      const n = Math.min(dst.length, src.length);
      dst.set(src.subarray(0, n));
      setInt64(sp + 40, n);
      mem().setUint8(sp + 48, 1);
    },
    "syscall/js.copyBytesToJS": (sp: number) => {
      sp >>>= 0;
      const dst = loadValue(sp + 8) as Uint8Array, src = loadSlice(sp + 16);
      if (!(dst instanceof Uint8Array || dst instanceof Uint8ClampedArray)) { mem().setUint8(sp + 48, 0); return; }
      const n = Math.min(dst.length, src.length);
      dst.set(src.subarray(0, n));
      setInt64(sp + 40, n);
      mem().setUint8(sp + 48, 1);
    },
  },
};

// ── Download + run WASM ───────────────────────────────────────────────────
async function init() {
  const { body } = await request(WASM_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Origin: "https://online.mbbank.com.vn",
      Referer: "https://online.mbbank.com.vn/",
    },
  });
  const chunks: Uint8Array[] = [];
  for await (const c of body) chunks.push(c as Uint8Array);
  const wasmBytes = Buffer.concat(chunks);

  const result = await WebAssembly.instantiate(wasmBytes, importObject);
  inst = result.instance;
  memView = new DataView((inst.exports.mem as WebAssembly.Memory).buffer);

  // values[5] = globalThis (Go's js.Global()), values[6] = go runtime
  _values = [NaN, 0, null, true, false, globalThis, goRuntime];
  _goRefCounts = new Array(_values.length).fill(Infinity);
  _ids = new Map<unknown, number>([[0, 1], [null, 2], [true, 3], [false, 4], [globalThis, 5], [goRuntime, 6]]);
  _idPool = [];

  const offset = 4096;
  const strPtr = (str: string) => {
    const bytes = textEnc.encode(str + "\0");
    new Uint8Array(memView.buffer, offset, bytes.length).set(bytes);
    return offset;
  };
  const argv = offset + 1024;
  new DataView(memView.buffer).setUint32(argv, strPtr("js"), true);
  (inst.exports.run as (argc: number, argv: number) => void)(1, argv);

  // Chờ WASM init xong và bder được set
  await new Promise((r) => setTimeout(r, 500));
}

async function main() {
  try {
    await init();
    const bder = (globalThis as any).bder;
    if (typeof bder !== "function") {
      parentPort!.postMessage({ error: `bder not a function, got ${typeof bder}` });
      return;
    }
    // Lắng nghe yêu cầu mã hoá từ main thread
    parentPort!.on("message", (payload: Record<string, unknown>) => {
      try {
        const result = bder(JSON.stringify(payload));
        parentPort!.postMessage({ dataEnc: result });
      } catch (e: any) {
        parentPort!.postMessage({ error: e.message });
      }
    });
    // Báo main thread rằng worker đã sẵn sàng
    parentPort!.postMessage({ ready: true });
  } catch (e: any) {
    parentPort!.postMessage({ error: e.message });
  }
}

main();
