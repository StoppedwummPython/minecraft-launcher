import sys
content = ""
with open("installer.py", "r") as f:
    content = f.read()

content = content.replace("!$!TAG!$!", sys.argv[1])

with open("installer.py", "w") as f:
    f.write(content)