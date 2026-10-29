// ninep.test.ts — 9P2000 library round-trip tests over loopback.
// In-memory tree only; no database, no app code.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { serveNineP, NinePClient, type DirNode, type FileNode } from "../src/ninep.ts";

function memFile(name: string, path: string, text: string, writable: boolean): FileNode {
  let content = new TextEncoder().encode(text);
  return {
    kind: "file", name, path,
    len: () => content.length,
    read: (off: number, count: number) => content.slice(off, off + count),
    write: writable
      ? (off: number, data: Uint8Array) => {
          if (off !== 0) throw new Error("offset must be 0");
          content = data;
          return data.length;
        }
      : undefined,
    truncate: writable ? () => { content = new Uint8Array(0); } : undefined,
    mtime: () => Date.now(),
  };
}

function memDir(name: string, path: string): DirNode & { add(n: any): void } {
  const kids = new Map<string, any>();
  return {
    kind: "dir", name, path,
    list: () => [...kids.values()].map((k) => ({ name: k.name, isDir: k.kind === "dir" })),
    get: (n: string) => kids.get(n) || null,
    create: (n: string, isDir: boolean) => {
      if (kids.has(n)) throw new Error("file exists");
      const node = isDir
        ? memDir(n, path + "/" + n)
        : memFile(n, path + "/" + n, "", true);
      kids.set(n, node);
      return node;
    },
    remove: undefined,
    mtime: () => Date.now(),
    add: (n: any) => kids.set(n.name, n),
  };
}

let server: any;
let port = 0;

beforeAll(() => {
  const root = memDir("", "/");
  root.add(memFile("hello", "/hello", "hello world", true));
  const sub = memDir("sub", "/sub");
  sub.add(memFile("x", "/sub/x", "x!", true));
  root.add(sub);
  const ro = memDir("ro", "/ro");
  ro.add(memFile("r", "/ro/r", "locked", false));
  root.add(ro);
  server = serveNineP(root, { port: 0 });
  port = server.port;
});

afterAll(() => {
  server.stop();
});

async function client() {
  const c = new NinePClient();
  await c.connect("127.0.0.1", port);
  return c;
}

describe("9P2000 library", () => {
  test("lists the root and reads a file", async () => {
    const c = await client();
    try {
      const names = (await c.listDir("/")).map((e) => e.name).sort();
      expect(names).toEqual(["hello", "ro", "sub"]);
      expect(await c.readFile("/hello")).toBe("hello world");
    } finally {
      c.close();
    }
  });

  test("writes replace the whole file", async () => {
    const c = await client();
    try {
      await c.writeFile("/hello", "short");
      expect(await c.readFile("/hello")).toBe("short");
      await c.writeFile("/hello", "a much longer replacement body");
      expect(await c.readFile("/hello")).toBe("a much longer replacement body");
    } finally {
      c.close();
    }
  });

  test("reads nested files and dir listings", async () => {
    const c = await client();
    try {
      expect(await c.readFile("/sub/x")).toBe("x!");
      expect(await c.listDir("/sub")).toEqual([{ name: "x", isDir: false }]);
    } finally {
      c.close();
    }
  });

  test("missing files and read-only writes fail", async () => {
    const c = await client();
    try {
      await expect(c.readFile("/nope")).rejects.toThrow();
      await expect(c.writeFile("/ro/r", "x")).rejects.toThrow();
    } finally {
      c.close();
    }
  });

  test("mkdir and createFile work", async () => {
    const c = await client();
    try {
      await c.mkdir("/fresh");
      await c.createFile("/fresh/note");
      await c.writeFile("/fresh/note", "noted");
      expect(await c.readFile("/fresh/note")).toBe("noted");
      expect(await c.listDir("/fresh")).toEqual([{ name: "note", isDir: false }]);
    } finally {
      c.close();
    }
  });

  // Regression: Rstat must carry the stat as a counted byte string
  // (u16 length prefix + stat). The server once sent the bare stat,
  // which our own client never noticed (it has no stat call) but
  // plan9port's 9p rejected: convM2D parsed the stat's inner size
  // field as the outer length. This speaks raw 9P and parses the
  // reply strictly, so it fails on the old framing.
  test("Tstat reply is a counted stat", async () => {
    const net = await import("node:net");
    const sock = net.connect(port, "127.0.0.1");
    await new Promise<void>((res) => sock.once("connect", res));
    let buf = Buffer.alloc(0);
    const waiters: { n: number; res: (b: Buffer) => void }[] = [];
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (const w of [...waiters]) {
        if (buf.length >= w.n) {
          waiters.splice(waiters.indexOf(w), 1);
          w.res(buf.subarray(0, w.n));
          buf = buf.subarray(w.n);
        }
      }
    });
    const readExact = (n: number) => new Promise<Buffer>((res) => {
      if (buf.length >= n) {
        const out = buf.subarray(0, n);
        buf = buf.subarray(n);
        res(out);
      } else waiters.push({ n, res });
    });
    const frame = async (type: number, tag: number, body: Buffer) => {
      const head = Buffer.alloc(7);
      head.writeUInt32LE(7 + body.length, 0);
      head.writeUInt8(type, 4);
      head.writeUInt16LE(tag, 5);
      sock.write(Buffer.concat([head, body]));
      const h = await readExact(7);
      const size = h.readUInt32LE(0);
      const rtype = h.readUInt8(4);
      const rest = await readExact(size - 7);
      return { rtype, body: rest };
    };
    const str = (s: string) => {
      const b = Buffer.from(s);
      const out = Buffer.alloc(2 + b.length);
      out.writeUInt16LE(b.length, 0);
      b.copy(out, 2);
      return out;
    };
    try {
      // Tversion (tag NOTAG)
      let r = await frame(100, 0xffff, Buffer.concat([
        (() => { const b = Buffer.alloc(4); b.writeUInt32LE(8192, 0); return b; })(),
        str("9P2000"),
      ]));
      expect(r.rtype).toBe(101);
      // Tattach fid 1, afid -1, uname "user", aname ""
      {
        const b = Buffer.alloc(8);
        b.writeUInt32LE(1, 0);
        b.writeUInt32LE(0xffffffff, 4);
        r = await frame(104, 1, Buffer.concat([b, str("user"), str("")]));
        expect(r.rtype).toBe(105);
      }
      // Twalk fid 1 -> 2, ["sub", "x"]
      {
        const b = Buffer.alloc(10);
        b.writeUInt32LE(1, 0);
        b.writeUInt32LE(2, 4);
        b.writeUInt16LE(2, 8);
        r = await frame(110, 2, Buffer.concat([b, str("sub"), str("x")]));
        expect(r.rtype).toBe(111);
      }
      // Tstat fid 2 (Tstat=124, Rstat=125)
      {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(2, 0);
        r = await frame(124, 3, b);
        expect(r.rtype).toBe(125); // Rstat
        const outer = r.body.readUInt16LE(0);
        expect(outer).toBe(r.body.length - 2);
        const st = r.body.subarray(2);
        const inner = st.readUInt16LE(0);
        expect(inner).toBe(st.length - 2);
        // length at 2+2+4+13+4+4+4 = 33, name str at 41
        expect(Number(st.readBigUInt64LE(33))).toBe(2); // "x!"
        const nameLen = st.readUInt16LE(41);
        expect(st.subarray(43, 43 + nameLen).toString()).toBe("x");
      }
    } finally {
      sock.destroy();
    }
  });
});
