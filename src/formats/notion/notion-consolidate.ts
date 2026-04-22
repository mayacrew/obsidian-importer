/**
 * Post-import image consolidation.
 *
 * After HTML→MD import, scans for local image wiki-embeds and
 * consolidates them into a dedicated "Images" folder:
 *   ![[image.png]]        → ![image](../Images/image.png)
 *   ![[image.png|120]]    → <img src="../Images/image.png" width="120" />
 */

import { Vault, TFile } from 'obsidian';
import { ImportContext } from '../../main';

const IMAGE_EXTS_RE = /\.(png|jpg|jpeg|gif|webp|heic|svg|bmp)$/i;

/** Matches ![[filename.ext]] and ![[filename.ext|width]] */
const EMBED_RE =
	/!\[\[([^\]|]+\.(?:png|jpg|jpeg|gif|webp|heic|svg|bmp))(?:\|(\d+))?\]\]/gi;

/**
 * Post-import step: scan MD files, consolidate images into
 * "Images" folder, and rewrite wiki-embed links.
 */
export async function consolidateImages(
	vault: Vault,
	ctx: ImportContext,
	targetFolderPath: string,
	attachmentFolderPath: string,
): Promise<{ consolidated: number; skipped: number }> {
	const imagesFolderPath = 'Images';
	let consolidated = 0;
	let skipped = 0;

	// Ensure images folder exists
	const imagesFolder = vault.getAbstractFileByPath(imagesFolderPath);
	if (!imagesFolder) {
		await vault.createFolder(imagesFolderPath);
	}

	const mdFiles = vault.getFiles().filter(
		(f) => f.extension === 'md' && f.path.startsWith(targetFolderPath)
	);

	const total = mdFiles.length;
	let current = 0;

	for (const md of mdFiles) {
		if (ctx.isCancelled()) break;

		current++;
		ctx.status(`Consolidating images (${current}/${total}): ${md.name}`);
		ctx.reportProgress(current, total);

		let text: string;
		try {
			text = await vault.cachedRead(md);
		} catch {
			continue;
		}

		if (!EMBED_RE.test(text)) continue;
		EMBED_RE.lastIndex = 0;

		type Match = { full: string; filename: string; width?: string };
		const matches: Match[] = [];
		let m: RegExpExecArray | null;
		while ((m = EMBED_RE.exec(text)) !== null) {
			matches.push({ full: m[0], filename: m[1], width: m[2] });
		}
		if (matches.length === 0) continue;

		let newText = text;
		let modified = false;

		for (const { full, filename, width } of matches) {
			// Try multiple locations for the image
			const mdDir = md.parent?.path ?? '';
			const possiblePaths = [
				`${mdDir}/${filename}`,
				attachmentFolderPath ? `${attachmentFolderPath}/${filename}` : null,
				filename,
			].filter(Boolean) as string[];

			let srcFile: TFile | null = null;
			for (const path of possiblePaths) {
				const file = vault.getAbstractFileByPath(path);
				if (file && file instanceof TFile) {
					srcFile = file;
					break;
				}
			}

			if (!srcFile) {
				skipped++;
				continue;
			}

			try {
				const data = await vault.readBinary(srcFile);
				const destPath = `${imagesFolderPath}/${filename}`;

				// Check if already exists
				if (!(await vault.adapter.exists(destPath))) {
					await vault.createBinary(destPath, data);
				}

				// Delete original file after copying
				try {
					await vault.delete(srcFile);
				} catch {
					// Silently ignore delete errors
				}

				consolidated++;

				// Rewrite embed - compute relative path from MD's directory to Images
				const mdDirDepth = (mdDir.match(/\//g) || []).length;
				const upDirs = '../'.repeat(mdDirDepth + 1);
				const altText = filename.replace(/\.[^.]+$/, '');
				const relPath = `${upDirs}Images/${filename}`;
				const replacement = width
					? `<img src="${relPath}" width="${width}" />`
					: `![${altText}](${relPath})`;

				newText = newText.replace(full, replacement);
				modified = true;
			} catch {
				skipped++;
			}
		}

		if (modified) {
			await vault.modify(md, newText);
		}
	}

	return { consolidated, skipped };
}
