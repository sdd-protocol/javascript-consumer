JavaScript consumer library for the [Simple Device Drawing Protocol](https://sddp.electricsheep.co)

## API

## Example: `hello-world`

_Note_: _All_ error handling here has been omitted for brevity. Don't do this!

```javascript
const SDDPConsumer = require('sddp-javascript-consumer');
new SDDPConsumer('my-app-id', 'my-prefix', { 
  host: 'my-redis-host', 
  password: 'my-redis-auth' 
})
.connect('target-display-id')
.then((display) => {
  display.clear();
  display.writeAt(10, 1, 'Hello');
  display.writeAt(11, 2, 'World!');
});
```