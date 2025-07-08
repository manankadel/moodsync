import os

IGNORE_DIRS = {
    ".git", "__pycache__", "venv", "env", "node_modules", ".next", ".vercel",
    ".idea", ".vscode", "dist", "build", ".pytest_cache", ".mypy_cache", "__pypackages__"
}

IGNORE_FILES = {
    ".DS_Store", "Thumbs.db", ".env", ".env.local", ".gitignore", "structure.txt", "code_dump.txt"
}

VALID_EXTENSIONS = {".py", ".html", ".js", ".css"}

def generate_structure_and_code(root_dir):
    structure_path = os.path.join(root_dir, "structure.txt")
    code_path = os.path.join(root_dir, "code_dump.txt")

    with open(structure_path, "w", encoding="utf-8") as sf, open(code_path, "w", encoding="utf-8") as cf:
        for root, dirs, files in os.walk(root_dir):
            dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
            files = [file for file in files if file not in IGNORE_FILES]

            level = root.replace(root_dir, "").count(os.sep)
            indent = "    " * level
            sf.write(f"{indent}{os.path.basename(root)}/\n")

            subindent = "    " * (level + 1)
            for file in files:
                sf.write(f"{subindent}{file}\n")

                ext = os.path.splitext(file)[1]
                if ext in VALID_EXTENSIONS:
                    file_path = os.path.join(root, file)
                    try:
                        with open(file_path, "r", encoding="utf-8") as source:
                            cf.write(f"\n\n========== {file_path} ==========\n")
                            cf.write(source.read())
                            cf.write("\n" + "="*60 + "\n")
                    except Exception as e:
                        print(f"⚠️ Skipped {file_path}: {e}")

    print("✅ structure.txt and code_dump.txt generated.")

if __name__ == "__main__":
    root_directory = os.path.dirname(os.path.abspath(__file__))
    generate_structure_and_code(root_directory)
