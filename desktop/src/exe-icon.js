'use strict';
// Sets / reads the icon of a Windows exe with resedit (pure JS, no wine, no rcedit).
const crypto = require('node:crypto');
const ResEdit = require('resedit');

const LANG = 1033;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Returns the exe bytes with every icon group replaced by the images of icoBuf (or group 1 created if none).
function setExeIcon(exeBuf, icoBuf) {
  const exe = ResEdit.NtExecutable.from(exeBuf, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const ico = ResEdit.Data.IconFile.from(icoBuf);
  const images = ico.icons.map((i) => i.data);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const targets = groups.length ? groups.map((g) => ({ id: g.id, lang: g.lang })) : [{ id: 1, lang: LANG }];
  for (const t of targets) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, t.id, t.lang, images);
  res.outputResource(exe);
  return Buffer.from(exe.generate());
}

// Reads back the icon group: [{width,height,sha256}] of each image (PNG or DIB payload), by size.
function readExeIcons(exeBuf) {
  const exe = ResEdit.NtExecutable.from(exeBuf, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const out = [];
  for (const g of ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)) {
    for (const ic of g.icons) {
      const e = res.entries.find((r) => r.type === 3 && r.id === ic.iconID);
      if (e) out.push({ group: g.id, width: ic.width || 256, height: ic.height || 256, sha256: sha(Buffer.from(e.bin)) });
    }
  }
  return out;
}
// The images inside an .ico file, parsed from its directory.
function icoImages(buf) {
  const n = buf.readUInt16LE(4), out = [];
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 16, size = buf.readUInt32LE(o + 8), off = buf.readUInt32LE(o + 12);
    out.push({ width: buf[o] || 256, height: buf[o + 1] || 256, sha256: sha(buf.subarray(off, off + size)) });
  }
  return out;
}
module.exports = { setExeIcon, readExeIcons, icoImages, sha };
