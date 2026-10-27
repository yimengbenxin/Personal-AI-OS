import {serveFake} from '../../ts-host/fake.ts';
await serveFake(new URL('../', import.meta.url));
