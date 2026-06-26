import { BlobReader, BlobWriter, Entry, TextWriter, ZipReader } from '@zip.js/zip.js';
import { parseFilePath, PickedFile } from './filesystem';

interface FileEntry extends Entry {
	directory: false;
	getData: NonNullable<Entry['getData']>;
}

export class ZipEntryFile implements PickedFile {
	type: 'file' = 'file';
	entry: FileEntry;
	fullpath: string;
	parent: string;
	name: string;
	basename: string;
	extension: string;

	constructor(zip: PickedFile, entry: FileEntry) {
		this.entry = entry;
		this.fullpath = zip.fullpath + '/' + entry.filename;
		let { parent, name, basename, extension } = parseFilePath(entry.filename);
		this.parent = parent;
		this.name = name;
		this.basename = basename;
		this.extension = extension;
	}

	async readText(): Promise<string> {
		return this.entry.getData(new TextWriter());
	}

	async read(): Promise<ArrayBuffer> {
		return (await this.entry.getData(new BlobWriter())).arrayBuffer();
	}

	get filepath() {
		return this.entry.filename;
	}

	get size() {
		return this.entry.uncompressedSize;
	}

	get ctime() {
		return this.entry.creationDate;
	}

	get mtime() {
		return this.entry.lastModDate;
	}

	async readZip(callback: (zip: ZipReader<any>) => Promise<void>): Promise<void> {
		// Stream the nested zip as a Blob instead of materializing it into a single
		// ArrayBuffer. Notion wraps large exports as a zip-in-zip whose inner part can
		// exceed the ~2GB single-ArrayBuffer limit; BlobReader reads it lazily by slice.
		const blob = await this.entry.getData(new BlobWriter());
		return callback(new ZipReader(new BlobReader(blob)));
	}

	/**
	 * Stream this entry's contents straight to a file on disk (desktop only), inflating
	 * chunk-by-chunk into a Node write stream. Avoids building a full-file ArrayBuffer,
	 * so multi-hundred-MB / multi-GB attachments import without exhausting memory or
	 * hitting the ~2GB single-buffer limit. `fullPath` must be an absolute filesystem path.
	 */
	async writeToFile(fullPath: string): Promise<void> {
		const fs = require('fs');
		const { dirname } = require('path');
		await fs.promises.mkdir(dirname(fullPath), { recursive: true });

		const nodeStream = fs.createWriteStream(fullPath);
		const writable = new WritableStream<Uint8Array>({
			write(chunk) {
				return new Promise((resolve, reject) => {
					nodeStream.write(Buffer.from(chunk), (err: any) => err ? reject(err) : resolve());
				});
			},
			close() {
				return new Promise((resolve, reject) => {
					nodeStream.end((err: any) => err ? reject(err) : resolve());
				});
			},
			abort() {
				nodeStream.destroy();
			},
		});

		try {
			await this.entry.getData(writable);
		}
		catch (e) {
			nodeStream.destroy();
			await fs.promises.rm(fullPath, { force: true }).catch(() => {});
			throw e;
		}
	}
}

export async function readZip(file: PickedFile, callback: (zip: ZipReader<any>, entries: ZipEntryFile[]) => Promise<void>) {
	await file.readZip(async zip => {
		let entries = await zip.getEntries();
		let files = entries
			.filter((entry): entry is FileEntry => !entry.directory && !!entry.getData)
			.map(entry => new ZipEntryFile(file, entry));

		return callback(zip, files);
	});
}
