/**
 * Post-import image consolidation.
 *
 * Move ALL image files under targetFolder to a single "Images" folder
 * and rewrite markdown links to point to it.
 */

import { Vault, TFile } from 'obsidian';
import { ImportContext } from '../../main';

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'bmp'] as const;
const IMAGE_EXT_SET = new Set<string>(IMAGE_EXTS);
const IMAGE_EXT_PATTERN = IMAGE_EXTS.join('|');

const IMAGES_FOLDER = 'Images';

// Regex capturing: ![[path/img.ext]] or ![[path/img.ext|width]]
const WIKI_EMBED_REGEX = new RegExp(
	`!\\[\\[([^\\]|]+\\.(?:${IMAGE_EXT_PATTERN}))(?:\\|(\\d+))?\\]\\]`,
	'gi',
);
// Regex capturing: ![alt](path/img.ext)
const MD_LINK_REGEX = new RegExp(
	`!\\[([^\\]]*)\\]\\(([^)]+\\.(?:${IMAGE_EXT_PATTERN}))\\)`,
	'gi',
);

/** Calculate `../` prefix to reach vault root from a note's parent folder. */
function getRelativeUpPath(mdParentPath: string | undefined): string {
	const depth = (mdParentPath?.match(/\//g) || []).length;
	return '../'.repeat(depth + 1);
}

/** Find the consolidated destination path for an original image reference. */
function resolveNewImagePath(imageMap: Map<string, string>, referencePath: string): string | null {
	for (const [oldPath, newPath] of imageMap) {
		if (oldPath.endsWith(referencePath) || oldPath.endsWith('/' + referencePath)) {
			return newPath;
		}
	}
	return null;
}

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
	let consolidated = 0;
	let skipped = 0;

	// Ensure Images folder exists
	if (!vault.getAbstractFileByPath(IMAGES_FOLDER)) {
		await vault.createFolder(IMAGES_FOLDER);
	}

	// Collect all image files under targetFolder
	const imageFiles: TFile[] = vault.getFiles().filter((file) =>
		file.path.startsWith(targetFolderPath) &&
		IMAGE_EXT_SET.has(file.extension.toLowerCase()),
	);

	// Move images to Images folder, tracking the old → new path mapping
	const imageMap = new Map<string, string>();

	for (const imgFile of imageFiles) {
		if (ctx.isCancelled()) break;
		ctx.status(`Moving images: ${imgFile.name}`);

		try {
			const destPath = `${IMAGES_FOLDER}/${imgFile.basename}`;

			if (!(await vault.adapter.exists(destPath))) {
				const data = await vault.readBinary(imgFile);
				await vault.createBinary(destPath, data);
			}

			imageMap.set(imgFile.path, destPath);

			try {
				await vault.delete(imgFile);
			}
			catch {
				// Silently ignore delete failures
			}

			consolidated++;
		}
		catch {
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
		}
		catch {
			continue;
		}

		const upDirs = getRelativeUpPath(md.parent?.path);
		let modified = false;

		// Replace wiki-embed links: ![[old-path/image.png]] or ![[old-path/image.png|width]]
		text = text.replace(WIKI_EMBED_REGEX, (match, path, width) => {
			const newPath = resolveNewImagePath(imageMap, path);
			if (!newPath) return match;

			const filename = newPath.split('/').pop()!;
			const relPath = `${upDirs}${IMAGES_FOLDER}/${filename}`;
			const altText = filename.replace(/\.[^.]+$/, '');

			modified = true;
			return width
				? `<img src="${relPath}" width="${width}" />`
				: `![${altText}](${relPath})`;
		});

		// Replace markdown links: ![alt](path/image.png)
		text = text.replace(MD_LINK_REGEX, (match, alt, path) => {
			const newPath = resolveNewImagePath(imageMap, path);
			if (!newPath) return match;

			const filename = newPath.split('/').pop()!;
			const relPath = `${upDirs}${IMAGES_FOLDER}/${filename}`;

			modified = true;
			return `![${alt}](${relPath})`;
		});

		if (modified) {
			await vault.modify(md, text);
		}
	}

	return { consolidated, skipped };
}
