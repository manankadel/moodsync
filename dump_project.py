import os

# Simple and explicit exclusions - only exclude what we know for sure
EXCLUDE_DIRS = {
    # Node.js
    "node_modules", ".next", ".turbo", ".vercel", ".expo", "dist", "build",
    
    # Python Virtual Environments - ONLY these specific names
    "venv", "env", ".venv", "virtualenv", "__pycache__", ".pytest_cache",
    
    # Version Control
    ".git", ".svn", ".hg",
    
    # IDEs & Editors  
    ".vscode", ".idea", ".vs",
    
    # Cache & Temp
    ".cache", ".tmp", "temp", ".nyc_output"
}

EXCLUDE_FILES = {
    # Lock files
    ".DS_Store", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
    "poetry.lock", "Pipfile.lock",
    
    # Environment files
    ".env", ".env.local", ".env.development", ".env.production",
    
    # Logs & generated files
    "*.log", "moodsync.log", "code_dump.txt", "project_structure.txt", "structure.txt",
    
    # Backup files
    "*.bak", "package.json.bak"
}

EXCLUDE_EXTENSIONS = {
    # Images & Media
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".bmp",
    ".mp4", ".mp3", ".wav", ".avi", ".mov", ".webm",
    
    # Fonts
    ".ttf", ".woff", ".woff2", ".eot", ".otf",
    
    # Archives & Binaries
    ".zip", ".tar", ".gz", ".rar", ".exe", ".dll", ".so", ".dylib",
    ".bin", ".deb", ".rpm",
    
    # Misc
    ".lock", ".log", ".cache", ".tmp", ".swp", ".backup"
}

structure_file = open("project_structure.txt", "w", encoding="utf-8")
code_dump_file = open("code_dump.txt", "w", encoding="utf-8")

def is_binary_or_excluded(filename):
    return (
        filename in EXCLUDE_FILES or
        any(filename.lower().endswith(ext) for ext in EXCLUDE_EXTENSIONS)
    )

def dump_structure_and_code(path, indent=""):
    try:
        items = sorted(os.listdir(path))
    except (PermissionError, OSError) as e:
        structure_file.write(f"{indent}[Permission denied: {e}]\n")
        return
    
    for item in items:
        full_path = os.path.join(path, item)

        if item in EXCLUDE_FILES:
            continue
            
        if os.path.isdir(full_path):
            # Only exclude directories that are explicitly in our exclude list
            if item in EXCLUDE_DIRS:
                structure_file.write(f"{indent}{item}/ [EXCLUDED]\n")
                continue
                
            # Keep ALL other directories (including lib, src, etc.)
            structure_file.write(f"{indent}{item}/\n")
            dump_structure_and_code(full_path, indent + "  ")
        else:
            if is_binary_or_excluded(item):
                structure_file.write(f"{indent}{item} [EXCLUDED]\n")
                continue
                
            structure_file.write(f"{indent}{item}\n")
            
            # Try to read and dump file content
            try:
                with open(full_path, "r", encoding="utf-8") as f:
                    content = f.read()
                    # Skip very large files (> 1MB of text)
                    if len(content) > 1024 * 1024:
                        code_dump_file.write(f"\n\n### {full_path} ###\n\n")
                        code_dump_file.write(f"[File too large: {len(content)} characters - SKIPPED]\n")
                    else:
                        code_dump_file.write(f"\n\n### {full_path} ###\n\n")
                        code_dump_file.write(content)
            except (UnicodeDecodeError, PermissionError) as e:
                code_dump_file.write(f"\n\n### {full_path} ###\n\n")
                code_dump_file.write(f"[Error reading file: {e}]\n")

if __name__ == "__main__":
    root_dir = "."  # Set to your project path if not in root
    
    print("🚀 Starting code dump...")
    print("📁 Analyzing project structure...")
    
    dump_structure_and_code(root_dir)
    
    structure_file.close()
    code_dump_file.close()
    
    # Get file sizes for summary
    try:
        struct_size = os.path.getsize("project_structure.txt") / 1024  # KB
        code_size = os.path.getsize("code_dump.txt") / 1024 / 1024     # MB
        
        print("✅ Done! Files created:")
        print(f"   📋 project_structure.txt ({struct_size:.1f} KB)")
        print(f"   💻 code_dump.txt ({code_size:.1f} MB)")
        
        if code_size > 50:
            print("⚠️  Warning: Code dump is quite large. Consider adding more exclusions.")
            
    except OSError:
        print("✅ Done. Files saved: 'project_structure.txt' and 'code_dump.txt'")