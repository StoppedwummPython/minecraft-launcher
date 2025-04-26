@echo off
REM This script is used to set up a development environment for a project
REM It installs necessary dependencies
npm i
node config_generator.js
node .