/**
 * Post-import image consolidation.
 *
 * Move ALL image files under targetFolder to a single "Images" folder
 * and rewrite markdown links to point to it.
 */

import { Vault, TFile, TFolder } from 'obsidian';
import { ImportContext } from '../../main';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'bmp']);

/**
 * Post-import step: collect all images from targetFolder subtree,
 * move them to "Images" folder, and rewrite all markdown links.
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

	// Ensure Images folder exists
	const imagesFolder = vault.getAbstractFileByPath(imagesFolderPath);
	if (!imagesFolder) {
		await vault.createFolder(imagesFolderPath);
	}

	// Collect all image files under targetFolder
	const imageFiles: TFile[] = [];
	const allFiles = vault.getFiles();
	for (const file of allFiles) {
		if (file.path.startsWith(targetFolderPath)) {
			const ext = file.extension.toLowerCase();
			if (IMAGE_EXTS.has(ext)) {
				imageFiles.push(file);
			}
		}
	}

	// Move images to Images folder
	const imageMap = new Map<string, string>(); // oldPath → newPath

	for (const imgFile of imageFiles) {
		if (ctx.isCancelled()) break;

		ctx.status(`Moving images: ${imgFile.name}`);

		try {
			const destPath = `${imagesFolderPath}/${imgFile.basename}`;

			// Check if already exists
			if (!(await vault.adapter.exists(destPath))) {
				const data = await vault.readBinary(imgFile);
				await vault.createBinary(destPath, data);
			}

			// Track the mapping
			imageMap.set(imgFile.path, destPath);

			// Delete original
			try {
				await vault.delete(imgFile);
			} catch {
				// Silently ignore
			}

			consolidated++;
		} catch {
			skipped++;
		}
	}

	// Update all markdown files with new image paths
	const mdFiles = vault.getFiles().filter((f) => f.extension === 'md');
	for (const md of mdFiles) {
		if (ctx.isCancelled()) break;

		ctx.status(`Updating links: ${md.name}`);

		let text: string;
		try {
			text = await vault.cachedRead(md);
		} catch {
			continue;
		}

		let modified = false;

		// Replace wiki-embed links: ![[old-path/image.png]] → ![](../Images/image.png)
		// Match both ![[path/image.ext]] and ![[path/image.ext|width]]
		const wikiEmbedRegex = /!\[\[([^\]|]+\.(?:png|jpg|jpeg|gif|webp|heic|svg|bmp))(?:\|(\d+))?\]\]/gi;
		text = text.replace(wikiEmbedRegex, (match, path, width) => {
			// Find which image this refers to
			for (const [oldPath, newPath] of imageMap) {
				if (oldPath.endsWith(path) || oldPath.endsWith('/' + path)) {
					const filename = newPath.split('/').pop()!;
					const mdDirDepth = (md.parent?.path?.match(/\//g) || []).length;
					const upDirs = '../'.repeat(mdDirDepth + 1);
					const altText = filename.replace(/\.[^.]+$/, '');
					const relPath = `${upDirs}Images/${filename}`;

					modified = true;
					return width
						? `<img src="${relPath}" width="${width}" />`
						: `![${altText}](${relPath})`;
				}
			}
			return match;
		});

		// Replace markdown links: ![alt](path/image.png) → ![alt](../Images/image.png)
		const mdLinkRegex = /!\[([^\]]*)\]\(([^)]+\.(?:png|jpg|jpeg|gif|webp|heic|svg|bmp))\)/gi;
		text = text.replace(mdLinkRegex, (match, alt, path) => {
			for (const [oldPath, newPath] of imageMap) {
				if (oldPath.endsWith(path) || oldPath.endsWith('/' + path)) {
					const filename = newPath.split('/').pop()!;
					const mdDirDepth = (md.parent?.path?.match(/\//g) || []).length;
					const upDirs = '../'.repeat(mdDirDepth + 1);
					const relPath = `${upDirs}Images/${filename}`;

					modified = true;
					return `![${alt}](${relPath})`;
				}
			}
			return match;
		});

		if (modified) {
			await vault.modify(md, text);
		}
	}

	return { consolidated, skipped };
}
