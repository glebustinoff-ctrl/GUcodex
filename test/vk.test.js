import test from 'node:test';
import assert from 'node:assert/strict';
import { VKMusic } from '../vk.js';

test('VK requires an audio-capable token and does not contact upstream without it',async () => {
  const vk = new VKMusic({token:'',fetchImpl:() => { throw new Error('unexpected request'); }});
  await assert.rejects(vk.search('Песня','Автор'),error => error.status === 424 && /VK_AUDIO_ACCESS_TOKEN/.test(error.message));
});

test('VK maps searches and imports media without forwarding API credentials to CDN',async () => {
  const requests=[];
  const vk = new VKMusic({token:'test-fixture-token',fetchImpl:async (target,options) => {
    const url = String(target); requests.push(url);
    if (url.includes('/method/')) {
      assert.equal(options.body.get('access_token'),'test-fixture-token');
      assert.equal(options.method,'POST');
      if(url.endsWith('audio.search')) return Response.json({response:{items:[{owner_id:-2,id:3,title:'Песня',artist:'Автор',duration:8,url:'not-returned-to-client'}]}});
      return Response.json({response:[{url:'https://audio.vkuseraudio.net/track.mp3',artist:'Автор',title:'Песня'}]});
    }
    assert.equal(options.headers,undefined); assert.equal(options.body,undefined);
    return new Response('audio-fixture',{headers:{'content-type':'audio/mpeg'}});
  }});
  const result = await vk.search('Песня','Автор');
  assert.equal(result.plus[0].id,'-2_3'); assert.equal(result.minus[0].title,'Песня');
  assert.equal(result.plus[0].url,undefined);
  const {response,name} = await vk.getFile('-2_3');
  assert.equal(await response.text(),'audio-fixture'); assert.equal(name,'Автор — Песня.mp3');
  assert.ok(requests.every(url => !url.includes('test-fixture-token')));
});

test('VK rejects unsafe media URLs, redirects, HLS and hides echoed credential errors',async () => {
  const vk = new VKMusic({token:'test-fixture-token',fetchImpl:async () => Response.json({error:{error_code:15,request_params:[{key:'access_token',value:'test-fixture-token'}]}})});
  await assert.rejects(vk.search('Песня','Автор'),e => e.status === 424 && !e.message.includes('test-fixture-token'));
  for(const url of ['http://audio.vkuseraudio.net/a.mp3','https://127.0.0.1/a.mp3','https://vkuseraudio.net.evil.test/a.mp3','https://audio.vkuseraudio.net:8080/a.mp3','https://user:secret@audio.vkuseraudio.net/a.mp3','https://audio.vkuseraudio.net/a.m3u8']) assert.throws(() => vk.validateMediaURL(url));
  let call=0;
  const redirecting = new VKMusic({token:'test',fetchImpl:async () => ++call===1 ? Response.json({response:[{url:'https://audio.vkuseraudio.net/a.mp3'}]}) : new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}})});
  await assert.rejects(redirecting.getFile('1_2'),/вне поддерживаемых/);
  assert.equal(call,2);
});
