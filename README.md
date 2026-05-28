# JEICalculator - Static Website


### TODO
- [ ] SPEED IT UP
- [ ] Make invalid search return item not found
- [ ] Toggle to hide emc items from raw materials
- [ ] Cache generated trees
- [ ] Cache search bar helper
- [ ] Limit the height of the canvas and spread the tree across a greater area
- [ ] Item vs fluid handling
- [ ] Initially expanded alt does not show current active
- [ ] Toggle fluids and items in raw materials
- [ ] Add quantity for root item
- [ ] Remove alternatives button for leaf + passive nodes
- [ ] Items in passived should be able to be expanded if it is the root
- [ ] Adding items to passive requiring a manual reload
- [ ] Add rmb menu for goto parent and add to passive list
- [ ] Look into keyboard controls
- [ ] Centering node on new alternative
- [ ] Presets of configs
- [ ] Passived text being weird
- [ ] Fix culling of lines between nodes when offscreen
- [ ] control + f to search node
- [ ] node search bar not working on non 100% zoom
- [ ] count matches in node search bar
- [ ] Clicking the sidebar a second time shifts the view
- [ ] Fix cycle on things that aren't cycles
- [ ] Summary view with intermediaries
### LOW PRIO
- [ ] Zoom smoothing
- [ ] Add recipe card previews when hovering over alteranatives
- [ ] Extract reusable from tooltip
- [ ] Small icon next to each node
- [ ] MMCE upgrades (no idea how I'm going to autogenerate these)
- [ ] Someday get rid of the item: tag before every item

### DONE
- [x] Create a search bar helper
- [x] Limit tree by total node count, not depth
- [x] Images
- [x] Multiply ingredient nodes to produce output
- [x] Create sidebar for to aggregate materials
- [x] Get machine rates, such as speed and energy costs
- [x] Read tooltip for emc
- [x] Tree search bar and focus
- [x] Clicking the item in the sidebar will highlight the nodes associated with it
- [x] Enable rebuilding of the tree by selecting alternative routes
- [x] Enable the marking of nodes as "Passive", which will stop further nodes from propagating
- [x] ~~Cache loaded recipe file~~ Lazy load recipes based on category
- [x] Add timers to show loading speeds
- [x] Filter out fluid filling / extracting recipes
- [x] Add machine priority between similar machines
- [x] Order raw materials by quantity
- [x] Handle recursive recipes
- [x] Redo passived tab
- [x] Passive item should accept both id and name
- [x] Make alternatives panel disapear on mouse click

### BUGS
- [ ] Fix rendering issue. Idk why it happens
### RECIPE FILTERING
- [x] Remove runic altar from runic altar recipes
- [x] Thaumotorium automation
- [ ] Resource miners
- [x] Master of spellcraft
- [x] HNN
- [x] living recursive essence
- [x] biome item
- [x] remove EIO power
- [x] Terminate all essentia by removing inputs from mechanized essentia smeltery
- [ ] Fix essentia quantity
- [x] Remove NC collector inputs
- [ ] Pure void, seared caster recipe missing
- [x] Mechanized coops
- [ ] Handle ore dictionary
- [ ] Remove redundant recipes when there is a clear upgrade
- [ ] Essence recipes