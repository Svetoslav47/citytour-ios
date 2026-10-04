/*
 * A downloaded course's pack (docs/SERVER.md §6): a SourcePackRepository (same
 * parsing, same per-file size + SHA-256 checks against the pack's own manifest.json, same lazy narrations and maps),
 * reading from a folder under filesDir/courses/<id>/<version>/. Every file was also verified
 * against the signed course manifest when it was downloaded (CourseStore).
 * The async read (pack load) uses FileStore (expo-file-system async reads); the lazy sync read (narrations, maps)
 * uses expo-file-system File.bytesSync(). `dir` is a file:// URI (FileStore path convention).
 */
import { File } from 'expo-file-system';
import { FileStore, toUri } from '../remote/FileStore';
import { PackSource, SourcePackRepository } from './SourcePackRepository';

export class FilePackSource implements PackSource {
  private readonly dir: string;

  /** dir: absolute folder of the pack, ending without '/'. */
  constructor(dir: string) {
    this.dir = dir;
  }

  label(): string {
    return 'file';
  }

  async read(file: string): Promise<Uint8Array> {
    const bytes = await FileStore.readBytes(`${this.dir}/${file}`);
    if (bytes === undefined) {
      throw new Error(`unreadable ${file}`);
    }
    return bytes;
  }

  readSync(file: string): Uint8Array {
    const f = new File(toUri(`${this.dir}/${file}`));
    const size = f.size;
    const out = f.bytesSync();
    if (out.length !== size) {
      throw new Error(`short read ${file}`);
    }
    return out;
  }
}

export class FilePackRepository extends SourcePackRepository {
  constructor(dir: string) {
    super(new FilePackSource(dir));
  }
}
