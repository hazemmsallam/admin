package com.eventticketing.admin.web;

import com.eventticketing.admin.client.TicketingApiException;
import com.eventticketing.admin.client.TicketingClient;
import com.eventticketing.admin.client.dto.CreateEventRequest;
import com.eventticketing.admin.client.dto.EventResponse;
import com.eventticketing.admin.client.dto.HallResponse;
import com.eventticketing.admin.client.dto.PricingItem;
import com.eventticketing.admin.client.dto.PricingResponse;
import com.eventticketing.admin.client.dto.SectionResponse;
import com.eventticketing.admin.client.dto.SetEventPricingRequest;
import com.eventticketing.admin.client.dto.UpdateEventStatusRequest;
import com.eventticketing.admin.web.form.EventForm;
import com.eventticketing.admin.web.form.PricingForm;
import jakarta.validation.Valid;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.validation.BindingResult;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ModelAttribute;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.servlet.mvc.support.RedirectAttributes;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;

@Controller
@RequestMapping("/events")
public class EventController {

    private static final DateTimeFormatter LOCAL = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm");
    private static final List<String> STATUSES = List.of("DRAFT", "PUBLISHED", "CANCELLED", "SOLD_OUT");

    private final TicketingClient client;

    public EventController(TicketingClient client) {
        this.client = client;
    }

    @GetMapping
    public String list(Model model) {
        model.addAttribute("events", client.listEvents());
        return "events/list";
    }

    @GetMapping("/new")
    public String createForm(Model model) {
        model.addAttribute("event", new EventForm());
        addFormOptions(model);
        return "events/form";
    }

    @PostMapping
    public String create(@Valid @ModelAttribute("event") EventForm form, BindingResult binding,
                         Model model, RedirectAttributes ra) {
        if (binding.hasErrors()) {
            addFormOptions(model);
            return "events/form";
        }
        try {
            EventResponse created = client.createEvent(toCreateRequest(form));
            ra.addFlashAttribute("success", "Event created. Set pricing, then publish it.");
            return "redirect:/events/" + created.id();
        } catch (TicketingApiException ex) {
            addFormOptions(model);
            model.addAttribute("error", ex.getMessage());
            return "events/form";
        }
    }

    @GetMapping("/{id}")
    public String view(@PathVariable Long id, Model model) {
        model.addAttribute("event", client.getEvent(id));
        model.addAttribute("statuses", STATUSES);
        return "events/view";
    }

    @GetMapping("/{id}/edit")
    public String editForm(@PathVariable Long id, Model model) {
        EventResponse event = client.getEvent(id);
        EventForm form = new EventForm();
        form.setName(event.name());
        form.setDescription(event.description());
        form.setCategory(event.category());
        form.setStartAt(toLocal(event.startAt()));
        form.setEndAt(toLocal(event.endAt()));
        form.setOrganizerId(event.organizer() != null ? event.organizer().id() : null);
        form.setHallId(event.hall() != null ? event.hall().id() : null);
        form.setMaxCapacity(event.maxCapacity());
        model.addAttribute("event", form);
        model.addAttribute("id", id);
        addFormOptions(model);
        return "events/form";
    }

    @PostMapping("/{id}")
    public String update(@PathVariable Long id, @Valid @ModelAttribute("event") EventForm form,
                         BindingResult binding, Model model, RedirectAttributes ra) {
        if (binding.hasErrors()) {
            model.addAttribute("id", id);
            addFormOptions(model);
            return "events/form";
        }
        try {
            client.updateEvent(id, toCreateRequest(form));
        } catch (TicketingApiException ex) {
            model.addAttribute("id", id);
            addFormOptions(model);
            model.addAttribute("error", ex.getMessage());
            return "events/form";
        }
        ra.addFlashAttribute("success", "Event updated.");
        return "redirect:/events/" + id;
    }

    @PostMapping("/{id}/status")
    public String changeStatus(@PathVariable Long id, @RequestParam String status, RedirectAttributes ra) {
        try {
            client.updateStatus(id, new UpdateEventStatusRequest(status));
            ra.addFlashAttribute("success", "Status changed to " + status + ".");
        } catch (TicketingApiException ex) {
            ra.addFlashAttribute("error", ex.getMessage());
        }
        return "redirect:/events/" + id;
    }

    @GetMapping("/{id}/pricing")
    public String pricingForm(@PathVariable Long id, Model model) {
        EventResponse event = client.getEvent(id);
        HallResponse hall = client.getHall(event.hall().id());
        model.addAttribute("event", event);
        model.addAttribute("hall", hall);
        model.addAttribute("pricing", toPricingForm(event, hall));
        return "events/pricing";
    }

    @PostMapping("/{id}/pricing")
    public String setPricing(@PathVariable Long id, @ModelAttribute("pricing") PricingForm form,
                             Model model, RedirectAttributes ra) {
        EventResponse event = client.getEvent(id);
        HallResponse hall = client.getHall(event.hall().id());
        List<PricingItem> items = new ArrayList<>();

        if (hall.sections() != null) {
            // Dynamic per-section pricing — any section name, any price.
            for (PricingForm.SectionPriceRow row : form.getSections()) {
                if (row != null && row.getSectionId() != null && row.getPrice() != null) {
                    items.add(new PricingItem(row.getSectionId(), row.getPrice()));
                }
            }
        }
        try {
            client.setPricing(id, new SetEventPricingRequest(items));
            ra.addFlashAttribute("success", "Pricing saved.");
            return "redirect:/events/" + id;
        } catch (TicketingApiException ex) {
            model.addAttribute("event", event);
            model.addAttribute("hall", hall);
            model.addAttribute("error", ex.getMessage());
            return "events/pricing";
        }
    }

    @PostMapping("/{id}/delete")
    public String delete(@PathVariable Long id, RedirectAttributes ra) {
        try {
            client.deleteEvent(id);
            ra.addFlashAttribute("success", "Event deleted.");
        } catch (TicketingApiException ex) {
            ra.addFlashAttribute("error", ex.getMessage());
        }
        return "redirect:/events";
    }

    // ---------------------------------------------------------------- helpers

    private void addFormOptions(Model model) {
        model.addAttribute("organizers", client.listOrganizers());
        model.addAttribute("halls", client.listHalls());
    }

    private CreateEventRequest toCreateRequest(EventForm form) {
        return new CreateEventRequest(
                form.getName(), form.getDescription(), form.getCategory(),
                toInstant(form.getStartAt()), toInstant(form.getEndAt()),
                form.getOrganizerId(), form.getHallId(), form.getMaxCapacity());
    }

    private PricingForm toPricingForm(EventResponse event, HallResponse hall) {
        PricingForm form = new PricingForm();

        // Existing per-section prices already configured for this event, keyed by section id.
        java.util.Map<Long, BigDecimal> pricedBySection = new java.util.HashMap<>();
        if (event.pricing() != null) {
            for (PricingResponse p : event.pricing()) {
                pricedBySection.put(p.sectionId(), p.price());
            }
        }

        if (hall.sections() != null) {
            for (SectionResponse section : hall.sections()) {
                PricingForm.SectionPriceRow row = new PricingForm.SectionPriceRow();
                row.setSectionId(section.id());
                row.setName(section.name());
                row.setBookingMode(section.bookingMode());
                row.setCurrency(section.currency());
                // Prefill with this event's configured price; blank until the admin sets one,
                // because a section has no price of its own.
                row.setPrice(pricedBySection.get(section.id()));
                form.getSections().add(row);
            }
        }
        return form;
    }

    private static Instant toInstant(String localDateTime) {
        return LocalDateTime.parse(localDateTime).toInstant(ZoneOffset.UTC);
    }

    private static String toLocal(Instant instant) {
        return instant == null ? "" : LocalDateTime.ofInstant(instant, ZoneOffset.UTC).format(LOCAL);
    }
}
