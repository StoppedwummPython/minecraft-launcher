#!/bin/bash

# This script will open a new Terminal window and run the command there
osascript -e "tell app \"Terminal\" to do script \"cd /Volumes/XCodeProjekte/minecraft-launcher && npm test && exit\""
