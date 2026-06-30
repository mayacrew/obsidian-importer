import { FileSystemAdapter, normalizePath, Notice, Setting, DataWriteOptions } from 'obsidian';
import { PickedFile } from '../filesystem';
import { FormatImporter } from '../format-importer';
import { ImportContext } from '../main';
import { extractErrorMessage } from '../util';
import { readZip, ZipEntryFile } from '../zip';
import { cleanDuplicates } from './notion/clean-duplicates';
import { readToMarkdown } from './notion/convert-to-md';
import { NotionResolverInfo } from './notion/notion-types';
import { getNotionId } from './notion/notion-utils';
import { parseFileInfo } from './notion/parse-info';
import { consolidateImages } from './notion/notion-consolidate';

const VAULT_ROOT_PATH = '/';
const VAULT_ROOT_LABEL = 'Vault Root (/)';

// Attachments larger than this are streamed to disk instead of read into one ArrayBuffer.
const LARGE_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export class NotionImporter extends FormatImporter {

	parentsInSubfolders: boolean;
	singleLineBreaks: boolean;
	consolidateImages: boolean;

	init() {
		this.parentsInSubfolders = true;
		this.addFileChooserSetting('Exported Notion', ['zip']);
		this.addOutputFolderDropdown();
		this.addToggleSetting(
			'Save parent pages in subfolders',
			'Places the parent database pages in the same folder as the nested content.',
			this.parentsInSubfolders,
			(v) => (this.parentsInSubfolders = v),
		);
		this.addToggleSetting(
			'Single line breaks',
			'Separate Notion blocks with only one line break (default is 2).',
			this.singleLineBreaks,
			(v) => (this.singleLineBreaks = v),
		);
		this.addToggleSetting(
			'Consolidate images locally',
			'After import, move all images to an "Images" folder.',
			this.consolidateImages,
			(v) => (this.consolidateImages = v),
		);
	}

	/** Build a dropdown of vault folders (root + all subfolders, excluding hidden). */
	private addOutputFolderDropdown() {
		this.outputLocation = VAULT_ROOT_PATH;
		const folders: Record<string, string> = { [VAULT_ROOT_PATH]: VAULT_ROOT_LABEL };
		this.collectVaultFolders(this.vault.getRoot(), folders);

		new Setting(this.modal.contentEl)
			.setName('Output folder')
			.setDesc('Choose where to import the notes.')
			.addDropdown((dropdown) => dropdown
				.addOptions(folders)
				.setValue(VAULT_ROOT_PATH)
				.onChange((value) => {
					this.outputLocation = value;
				}));
	}

	/** Recursively collect all non-hidden folder paths into the folders map. */
	private collectVaultFolders(parent: any, folders: Record<string, string>) {
		for (const child of parent.children) {
			if (child.children !== undefined && !child.name.startsWith('.')) {
				folders[child.path] = child.path;
				this.collectVaultFolders(child, folders);
			}
		}
	}

	/** Add a toggle setting with consistent wiring. */
	private addToggleSetting(name: string, desc: string, initial: boolean, onChange: (value: boolean) => void) {
		new Setting(this.modal.contentEl)
			.setName(name)
			.setDesc(desc)
			.addToggle((toggle) => toggle
				.setValue(initial)
				.onChange(onChange));
	}

	async getOutputFolder() {
		if (!this.outputLocation || this.outputLocation === '/') {
			return this.app.vault.getRoot();
		}
		return super.getOutputFolder();
	}

	async import(ctx: ImportContext): Promise<void> {
		const { vault, parentsInSubfolders, files } = this;
		if (files.length === 0) {
			new Notice('Please pick at least one file to import.');
			return;
		}

		const folder = await this.getOutputFolder();
		if (!folder) {
			new Notice('Please select a location to export to.');
			return;
		}

		let targetFolderPath = folder.path;
		targetFolderPath = normalizePath(targetFolderPath);
		// As a convention, all parent folders should end with "/" in this importer.
		if (!targetFolderPath?.endsWith('/')) targetFolderPath += '/';

		// Force Images folder for consolidated image storage
		const info = new NotionResolverInfo('Images', this.singleLineBreaks);

		// loads in only path & title information to objects
		ctx.status('Looking for files to import');
		let total = 0;
		await processZips(ctx, files, async (file) => {
			try {
				await parseFileInfo(info, file);
				total = Object.keys(info.idsToFileInfo).length + Object.keys(info.pathsToAttachmentInfo).length;
				ctx.reportProgress(0, total);
			}
			catch {
				ctx.reportSkipped(file.fullpath);
			}
		});
		if (ctx.isCancelled()) return;

		ctx.status('Resolving links and de-duplicating files');

		cleanDuplicates({
			vault,
			info,
			targetFolderPath,
			parentsInSubfolders,
		});

		const flatFolderPaths = new Set<string>([targetFolderPath]);
		const allFolderPaths = Object.values(info.idsToFileInfo)
			.map((fileInfo) => targetFolderPath + info.getPathForFile(fileInfo))
			.concat(Object.values(info.pathsToAttachmentInfo).map(
				(attachmentInfo) => attachmentInfo.targetParentFolder
			));
		for (let folderPath of allFolderPaths) {
			flatFolderPaths.add(folderPath);
		}
		for (let path of flatFolderPaths) {
			if (ctx.isCancelled()) return;
			await this.createFolders(path);
		}

		let current = 0;
		ctx.status('Starting import');
		await processZips(ctx, files, async (file) => {
			current++;
			ctx.reportProgress(current, total);

			try {
				if (file.extension === 'html') {
					const id = getNotionId(file.name);
					if (!id) {
						throw new Error('ids not found for ' + file.filepath);
					}
					const fileInfo = info.idsToFileInfo[id];
					if (!fileInfo) {
						throw new Error('file info not found for ' + file.filepath);
					}

					ctx.status(`Importing note ${fileInfo.title}`);

					const markdownBody = await readToMarkdown(info, file);
					let writeOptions: DataWriteOptions = {};

					if (fileInfo.ctime) {
						writeOptions.ctime = fileInfo.ctime.getTime();
						writeOptions.mtime = fileInfo.ctime.getTime();
					}

					if (fileInfo.mtime) {
						writeOptions.mtime = fileInfo.mtime.getTime();
					}

					const basePath = `${targetFolderPath}${info.getPathForFile(fileInfo)}${fileInfo.title}`;
					let path = `${basePath}.md`;
					// If file already exists (duplicate title), append numeric suffix
					if (await vault.adapter.exists(path)) {
						let suffix = 2;
						while (await vault.adapter.exists(`${basePath} ${suffix}.md`)) {
							suffix++;
						}
						path = `${basePath} ${suffix}.md`;
					}
					await vault.create(path, markdownBody, writeOptions);
					ctx.reportNoteSuccess(file.fullpath);
				}
				else {
					const attachmentInfo = info.pathsToAttachmentInfo[file.filepath];
					if (!attachmentInfo) {
						throw new Error('attachment info not found for ' + file.filepath);
					}

					ctx.status(`Importing attachment ${file.name}`);

					const path = normalizePath(`Images/${attachmentInfo.nameWithExtension}`);
					// Notes reference attachments by this exact filename, so we can't rename
					// duplicates without breaking links. Skip if already written instead of failing.
					if (await vault.adapter.exists(path)) {
						ctx.reportSkipped(file.fullpath, 'attachment already exists');
					}
					else {
						const adapter = vault.adapter;
						// Stream large attachments straight to disk to avoid loading the whole
						// file into a single ArrayBuffer (memory blowup / ~2GB buffer limit).
						if (adapter instanceof FileSystemAdapter && file.size > LARGE_ATTACHMENT_BYTES) {
							await file.writeToFile(adapter.getFullPath(path));
						}
						else {
							const data = await file.read();
							await vault.createBinary(path, data);
						}
						ctx.reportAttachmentSuccess(file.fullpath);
					}
				}
			}
			catch (e) {
				if (extractErrorMessage(e) === 'page body was not found') {
					ctx.reportSkipped(file.fullpath, 'page body was not found');
					return;
				}

				ctx.reportFailed(file.fullpath, e);
			}
		});

		// Post-import: consolidate images to notion-images folder
		if (this.consolidateImages && !ctx.isCancelled()) {
			ctx.status('Consolidating images...');
			const attachmentFolderPath = vault.getConfig('attachmentFolderPath') ?? '';
			const { consolidated, skipped } = await consolidateImages(
				vault, ctx, targetFolderPath, attachmentFolderPath
			);
			if (consolidated > 0 || skipped > 0) {
				new Notice(`Image consolidation complete: ${consolidated} consolidated, ${skipped} skipped`);
			}
		}
	}
}

async function processZips(ctx: ImportContext, files: PickedFile[], callback: (file: ZipEntryFile) => Promise<void>) {
	for (let zipFile of files) {
		if (ctx.isCancelled()) return;
		try {
			await readZip(zipFile, async (zip, entries) => {
				for (let entry of entries) {
					if (ctx.isCancelled()) return;

					// throw an error for Notion Markdown exports
					if (entry.extension === 'md' && getNotionId(entry.name)) {
						new Notice('Notion Markdown export detected. Please export Notion data to HTML instead.');
						ctx.cancel();
						throw new Error('Notion importer uses only HTML exports. Please use the correct format.');
					}

					// Skip databses in CSV format
					if (entry.extension === 'csv' && getNotionId(entry.name)) continue;

					// Skip summary files
					if (entry.name === 'index.html') continue;

					// Only recurse into zip files if they are at the root of the parent zip
					// because users can attach zip files to Notion, and they should be considered
					// attachment files.
					if (entry.extension === 'zip' && entry.parent === '') {
						try {
							await processZips(ctx, [entry], callback);
						}
						catch (e) {
							ctx.reportFailed(entry.fullpath, e);
						}
					}
					else {
						await callback(entry);
					}
				}
			});
		}
		catch (e) {
			ctx.reportFailed(zipFile.fullpath, e);
		}
	}
}
