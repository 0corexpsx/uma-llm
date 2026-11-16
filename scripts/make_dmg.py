"""Wraps a raw disk image in Apple's compressed UDIF format (UDZO), the usual .dmg.

  python make_dmg.py <raw image> <output.dmg>

Layout, as hdiutil writes it: the zlib-compressed chunks (the data fork), an XML property list
whose "blkx" entry maps every chunk to its sectors, and a 512-byte "koly" trailer pointing at both.
All numbers are big-endian. Checksums are CRC32: one over the uncompressed data of the partition,
a master one over the partition checksums, and one over the data fork.
"""
import plistlib
import struct
import sys
import uuid
import zlib

SECTOR = 512
CHUNK_SECTORS = 0x800  # 1 MiB of image per compressed chunk
ZLIB, ZERO, END = 0x80000005, 0x00000002, 0xFFFFFFFF
CRC32 = 2


def checksum(value):
    """UDIFChecksum: type, size in bits, then 32 words of which only the first is used."""
    return struct.pack(">II", CRC32, 32) + struct.pack(">I", value) + bytes(124)


def build(source, target):
    with open(source, "rb") as f:
        image = f.read()
    if len(image) % SECTOR:
        image += bytes(SECTOR - len(image) % SECTOR)
    sectors = len(image) // SECTOR

    runs = []
    data_fork = bytearray()
    for first in range(0, sectors, CHUNK_SECTORS):
        count = min(CHUNK_SECTORS, sectors - first)
        chunk = image[first * SECTOR:(first + count) * SECTOR]
        if chunk.count(0) == len(chunk):
            runs.append((ZERO, first, count, len(data_fork), 0))
        else:
            packed = zlib.compress(chunk, 9)
            runs.append((ZLIB, first, count, len(data_fork), len(packed)))
            data_fork += packed
    runs.append((END, sectors, 0, len(data_fork), 0))

    data_crc = zlib.crc32(image)
    mish = struct.pack(
        ">4sIQQQII24s",
        b"mish", 1,
        0,            # first sector of this partition
        sectors,
        0,            # data start: chunk offsets below are from the start of the file
        CHUNK_SECTORS + 8,  # decompression buffer, in sectors
        0,            # partition number
        bytes(24),
    ) + checksum(data_crc) + struct.pack(">I", len(runs))
    for kind, first, count, offset, length in runs:
        mish += struct.pack(">IIQQQQ", kind, 0, first, count, offset, length)

    plist = plistlib.dumps({
        "resource-fork": {
            "blkx": [{
                "Attributes": "0x0050",
                "CFName": "whole disk (unknown partition : 0)",
                "Data": bytes(mish),
                "ID": "-1",
                "Name": "whole disk (unknown partition : 0)",
            }],
        },
    })
    master_crc = zlib.crc32(struct.pack(">I", data_crc))

    koly = struct.pack(
        ">4sIIIQQQQQII16s",
        b"koly", 4, 512, 1,
        0, 0, len(data_fork),   # running data fork offset, data fork offset and length
        0, 0,                   # no resource fork
        1, 1, uuid.uuid4().bytes,
    ) + checksum(zlib.crc32(data_fork)) + struct.pack(">QQ", len(data_fork), len(plist)) + bytes(120) \
        + checksum(master_crc) + struct.pack(">IQ", 1, sectors) + bytes(12)
    assert len(koly) == 512 and len(mish) == 204 + 40 * len(runs)

    with open(target, "wb") as f:
        f.write(data_fork)
        f.write(plist)
        f.write(koly)
    print(f"wrote {target} ({(len(data_fork) + len(plist) + 512) / 1048576:.1f} MB, image {len(image) / 1048576:.1f} MB)")


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2])
