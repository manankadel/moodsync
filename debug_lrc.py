# debug_lrc.py - Debug script for lrc_kit API
import inspect

print("=== Debugging lrc_kit API ===")

try:
    from lrc_kit.lrc import LRC as Lrc
    print("✅ Successfully imported LRC as Lrc")
    
    # Check class methods and attributes
    print(f"\n--- Lrc class methods ---")
    for name, method in inspect.getmembers(Lrc, predicate=inspect.ismethod):
        print(f"  - {name}")
    
    print(f"\n--- Lrc class functions ---")
    for name, func in inspect.getmembers(Lrc, predicate=inspect.isfunction):
        print(f"  - {name}")
    
    print(f"\n--- All Lrc attributes ---")
    for attr in dir(Lrc):
        if not attr.startswith('_'):
            print(f"  - {attr}")
    
    # Try to create an instance and check its methods
    try:
        instance = Lrc()
        print(f"\n--- Instance methods ---")
        for name, method in inspect.getmembers(instance, predicate=inspect.ismethod):
            if not name.startswith('_'):
                print(f"  - {name}")
    except Exception as e:
        print(f"\n--- Could not create instance: {e} ---")
        
    # Check constructor signature
    if callable(Lrc):
        try:
            sig = inspect.signature(Lrc.__init__)
            print(f"\n--- Constructor signature: {sig} ---")
        except:
            print("\n--- Couldn't get constructor signature ---")
            
except Exception as e:
    print(f"❌ Error importing LRC: {e}")
    
# Also try importing the whole module
try:
    import lrc_kit.lrc as lrc_module
    print(f"\n--- lrc_module contents ---")
    for attr in dir(lrc_module):
        if not attr.startswith('_'):
            print(f"  - {attr}")
except Exception as e:
    print(f"❌ Error importing lrc module: {e}")

print("\n=== Debug complete ===")