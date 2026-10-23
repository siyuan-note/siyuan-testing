import {inflateRawSync} from "node:zlib";

const findEndOfCentralDirectory = (archive: Buffer) => {
    if (archive.length < 22) {
        throw new Error("ZIP end of central directory was not found");
    }
    const minimumOffset = Math.max(0, archive.length - 22 - 0xffff);
    for (let offset = archive.length - 22; offset >= minimumOffset; offset--) {
        if (archive.readUInt32LE(offset) !== 0x06054b50) {
            continue;
        }
        const commentLength = archive.readUInt16LE(offset + 20);
        if (offset + 22 + commentLength === archive.length) {
            return offset;
        }
    }
    throw new Error("ZIP end of central directory was not found");
};

export const readZipEntries = (archive: Buffer) => {
    const entries = new Map<string, Buffer>();
    const endOfCentralDirectory = findEndOfCentralDirectory(archive);
    const totalEntries = archive.readUInt16LE(endOfCentralDirectory + 10);
    let offset = archive.readUInt32LE(endOfCentralDirectory + 16);
    if (totalEntries === 0xffff || offset === 0xffffffff) {
        throw new Error("ZIP64 archives are not supported");
    }
    for (let index = 0; index < totalEntries; index++) {
        if (offset > archive.length - 46 || archive.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error(`invalid ZIP central directory entry at offset ${offset}`);
        }
        const method = archive.readUInt16LE(offset + 10);
        const compressedSize = archive.readUInt32LE(offset + 20);
        const filenameLength = archive.readUInt16LE(offset + 28);
        const extraLength = archive.readUInt16LE(offset + 30);
        const commentLength = archive.readUInt16LE(offset + 32);
        const localHeaderOffset = archive.readUInt32LE(offset + 42);
        const filename = archive.subarray(offset + 46, offset + 46 + filenameLength).toString("utf8");
        if (localHeaderOffset > archive.length - 30 || archive.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
            throw new Error(`invalid ZIP local header for ${filename}`);
        }
        const localFilenameLength = archive.readUInt16LE(localHeaderOffset + 26);
        const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
        const dataOffset = localHeaderOffset + 30 + localFilenameLength + localExtraLength;
        if (dataOffset + compressedSize > archive.length) {
            throw new Error(`invalid ZIP entry data for ${filename}`);
        }
        const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
        if (!filename.endsWith("/")) {
            if (method === 0) {
                entries.set(filename, compressed);
            } else if (method === 8) {
                entries.set(filename, inflateRawSync(compressed));
            } else {
                throw new Error(`unsupported ZIP compression method ${method} for ${filename}`);
            }
        }
        offset += 46 + filenameLength + extraLength + commentLength;
    }
    return entries;
};
