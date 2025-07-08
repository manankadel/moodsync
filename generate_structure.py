import os

IGNORE_DIRS = {
    ".git", "__pycache__", "venv", "env", "node_modules", ".next", ".vercel",
    ".idea", ".vscode", ".DS_Store", "dist", "build", ".pytest_cache", ".mypy_cache"
}
IGNORE_FILES = {
    ".DS_Store", "Thumbs.db", ".env", ".env.local", ".gitignore"
}

def generate_structure(root_dir, output_file="structure.txt"):
    with open(output_file, "w", encoding="utf-8") as f:
        for root, dirs, files in os.walk(root_dir):
            # Filter ignored directories
            dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
            files = [file for file in files if file not in IGNORE_FILES]

            level = root.replace(root_dir, "").count(os.sep)
            indent = "    " * level
            f.write(f"{indent}{os.path.basename(root)}/\n")

            subindent = "    " * (level + 1)
            for file in files:
                f.write(f"{subindent}{file}\n")

if __name__ == "__main__":
    root_directory = os.path.dirname(os.path.abspath(__file__))
    generate_structure(root_directory)
    print("✅ Cleaned structure.txt generated.")
