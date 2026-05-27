import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, basename, extname } from 'path';

/**
 * AbleSpeak Library Scanner
 * Scans ~/.voqal/library/ to discover tools, contexts, and prompts
 */

export class LibraryScanner {
  constructor(libraryPath) {
    this.libraryPath = libraryPath;
    this.cache = null;
    this.cacheTime = 0;
    this.cacheTTL = 30000; // 30s cache
  }

  scan() {
    if (this.cache && Date.now() - this.cacheTime < this.cacheTTL) return this.cache;
    if (!existsSync(this.libraryPath)) return { categories: [] };

    const categories = [];
    const entries = readdirSync(this.libraryPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const catPath = join(this.libraryPath, entry.name);
      const category = { name: entry.name, tools: [], contexts: [], prompts: [] };

      // Scan tools
      const toolsDir = join(catPath, 'tools');
      if (existsSync(toolsDir)) {
        const toolEntries = readdirSync(toolsDir, { withFileTypes: true });
        for (const te of toolEntries) {
          if (!te.isDirectory()) continue;
          const toolDir = join(toolsDir, te.name);
          const tool = this._parseToolDir(toolDir, te.name);
          if (tool) category.tools.push(tool);
        }
      }

      // Scan contexts
      const ctxDir = join(catPath, 'context');
      if (existsSync(ctxDir)) {
        const ctxEntries = readdirSync(ctxDir, { withFileTypes: true });
        for (const ce of ctxEntries) {
          if (!ce.isDirectory()) continue;
          category.contexts.push({ name: ce.name });
        }
      }

      // Scan prompt files
      const mdFiles = readdirSync(catPath).filter(f => f.endsWith('.md') && !f.startsWith('_'));
      for (const mf of mdFiles) {
        try {
          const content = readFileSync(join(catPath, mf), 'utf-8');
          category.prompts.push({ name: basename(mf, '.md'), content: content.slice(0, 2000) });
        } catch {}
      }

      categories.push(category);
    }

    this.cache = { categories, scannedAt: new Date().toISOString() };
    this.cacheTime = Date.now();
    return this.cache;
  }

  getToolDetail(categoryName, toolName) {
    const toolDir = join(this.libraryPath, categoryName, 'tools', toolName);
    if (!existsSync(toolDir)) return null;
    return this._parseToolDir(toolDir, toolName, true);
  }

  _parseToolDir(toolDir, toolName, includeCode = false) {
    const files = readdirSync(toolDir);
    const tool = { name: toolName, yaml: null, code: null, codeLanguage: null, jsonSchema: null };

    for (const f of files) {
      const fp = join(toolDir, f);
      const ext = extname(f);
      try {
        if (ext === '.yaml' || ext === '.yml') {
          tool.yaml = readFileSync(fp, 'utf-8');
          // Extract description from YAML
          const descMatch = tool.yaml.match(/description:\s*(.+)/);
          if (descMatch) tool.description = descMatch[1].trim();
          // Extract JSON function schema from YAML
          tool.jsonSchema = this._extractJsonSchema(tool.yaml, toolName);
        } else if (ext === '.kt' || ext === '.js') {
          tool.code = readFileSync(fp, 'utf-8');
          tool.codeLanguage = ext === '.kt' ? 'kotlin' : 'javascript';
        }
      } catch {}
    }

    return tool.yaml ? tool : null;
  }

  _extractJsonSchema(yaml, toolName) {
    try {
      const schema = { name: toolName, parameters: { type: 'object', properties: {}, required: [] }, description: '' };

      // Extract description
      const descMatch = yaml.match(/^\s+description:\s*(.+)$/m);
      if (descMatch) schema.description = descMatch[1].trim().replace(/^["']|["']$/g, '');

      // Extract properties block — simple line-by-line parser
      const lines = yaml.split('\n');
      let inProperties = false;
      let inRequired = false;
      let currentProp = null;

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === 'properties:') { inProperties = true; inRequired = false; continue; }
        if (trimmed === 'required:') { inRequired = true; inProperties = false; continue; }
        if (trimmed.startsWith('exec:') || trimmed.startsWith('selector:')) { inProperties = false; inRequired = false; continue; }

        if (inProperties) {
          // Property name (ends with colon, no value)
          const propNameMatch = trimmed.match(/^(\w+):$/);
          if (propNameMatch) {
            currentProp = propNameMatch[1];
            schema.parameters.properties[currentProp] = {};
            continue;
          }
          if (currentProp) {
            const typeMatch = trimmed.match(/^type:\s*(.+)/);
            if (typeMatch) schema.parameters.properties[currentProp].type = typeMatch[1].trim();
            const propDescMatch = trimmed.match(/^description:\s*(.+)/);
            if (propDescMatch) schema.parameters.properties[currentProp].description = propDescMatch[1].trim().replace(/^["']|["']$/g, '');
          }
        }

        if (inRequired) {
          const reqMatch = trimmed.match(/^-\s*(.+)/);
          if (reqMatch) schema.parameters.required.push(reqMatch[1].trim());
        }
      }

      return schema;
    } catch {
      return null;
    }
  }
}
