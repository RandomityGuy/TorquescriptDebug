# Torquescript Debugger
A Torquescript debugger for the Torque Game Engine.  
Works by interfacing with the Telnet debugger exposed by the engine.  

### Features:
- Breakpoints including conditional ones, step in, step out, step over, continue
- Local and Global variables, as well as editing them
- Call stack
- Watch expressions
- Console output
- Console REPL
- Variable Hover evaluation

### Usage:
- Run the game with dbgSetParameters called with the desired port and password
- Launch configuration:
```json
{
    "type": "torque-debug",
    "request": "attach",
    "name": "Attach to Torque",
    "address": <address>,
    "port": <port number>,
    "password": <password>,
    "rootDir": <the root directory of the project, may be left blank>
}
```
If the source files of the game are in a subdirectory of the VSCode workspace, the rootDir parameter should be set to the relative path of the subdirectory.  
Eg. if the source files are in a folder named "game", the rootDir should be set to "game".  