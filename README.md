JavaScript consumer library for the [Simple Device Drawing Protocol](https://sddp.electricsheep.co)

## API

## Example: `hello-world`

_Note_: Nearly all error handling here has been omitted for brevity. Don't do this!

```javascript
const SDDPConsumer = require('sddp-javascript-consumer');
new SDDPConsumer('hello-world', 'prefix', { 
  host: '...', 
  password: '...' 
}, { 
  logger: console
})
.connect(process.argv.pop() || 'targetDisplayId')
.then((display) => {
  display.clear();
  display.writeAt(3, 0, 'Hello');
  display.writeAt(4, 1, 'World!');
  const timeStr = new Date().toLocaleTimeString();
  display.writeAt(20 - timeStr.length, 3, timeStr);
  display.disconnect();
})
.catch((err) => {
  console.error('Connection failed:', err);
  process.exit(-1);
});
```