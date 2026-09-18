/**
 * CRC-32 (IEEE 802.3), table-driven — the checksum each ZIP entry carries.
 *
 * The dApp's own copy (tab isolation): copied from the console's
 * frontend/src/components/xlsx.js, which the dApp must not import — an import
 * would also pull the console's XLSX writer and its shared chunk into the
 * key-holding page's first load, and let a console edit change the dApp's
 * import parser silently.
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
